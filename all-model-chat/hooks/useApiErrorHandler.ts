import { useCallback, useRef } from 'react';
import { logService } from '../utils/appUtils';
import { SavedChatSession } from '../types';
import { forceRotateApiKey } from '../utils/apiUtils';

type SessionsUpdater = (updater: (prev: SavedChatSession[]) => SavedChatSession[]) => void;

// 存储每个消息的重试次数
const messageRetryCount = new Map<string, number>();

// 检测是否是配额限制错误
const isQuotaError = (error: Error): boolean => {
    const errorStr = error.message.toLowerCase();
    return errorStr.includes('429') || 
           errorStr.includes('quota') || 
           errorStr.includes('rate limit') ||
           errorStr.includes('resource exhausted');
};

// 检测是否应该重试
const shouldRetryError = (error: Error): boolean => {
    const errorStr = error.message.toLowerCase();
    // 可重试的错误：网络错误、超时、5xx 错误等
    return errorStr.includes('network') ||
           errorStr.includes('timeout') ||
           errorStr.includes('503') ||
           errorStr.includes('502') ||
           errorStr.includes('500');
};

export const useApiErrorHandler = (updateAndPersistSessions: SessionsUpdater) => {
    const appSettingsRef = useRef<any>(null);
    
    const handleApiError = useCallback((error: unknown, sessionId: string, modelMessageId: string, errorPrefix: string = "Error", appSettings?: any) => {
        const isAborted = error instanceof Error && (error.name === 'AbortError' || error.message === 'aborted');
        logService.error(`API Error (${errorPrefix}) for message ${modelMessageId} in session ${sessionId}`, { error, isAborted });
        
        if (isAborted) {
            // Optimistic update in useMessageActions.handleStopGenerating now handles the UI change immediately.
            // This function's role for AbortError is now just to log it and let the stream cleanup occur naturally.
            // No UI state change is needed here to prevent race conditions.
            return;
        }

        // 保存 appSettings 引用供 key 轮换使用
        if (appSettings) {
            appSettingsRef.current = appSettings;
        }

        let errorMessage = "An unknown error occurred.";
        let shouldRotateKey = false;
        let shouldRetry = false;

        if (error instanceof Error) {
            errorMessage = error.name === 'SilentError'
                ? "API key is not configured in settings."
                : `${errorPrefix}: ${error.message}`;

            // 检查是否是 429 配额错误
            if (isQuotaError(error)) {
                shouldRotateKey = true;
                errorMessage += "\n\n[Switching to next API key...]";
                logService.warn(`Quota error detected for message ${modelMessageId}, will rotate API key.`);
            } 
            // 检查是否是可重试的错误
            else if (shouldRetryError(error)) {
                const retryCount = messageRetryCount.get(modelMessageId) || 0;
                
                if (retryCount < 1) {
                    // 第一次错误，标记重试
                    messageRetryCount.set(modelMessageId, retryCount + 1);
                    shouldRetry = true;
                    errorMessage += "\n\n[Retrying...]";
                    logService.info(`Will retry message ${modelMessageId} (attempt ${retryCount + 1}/1)`);
                } else {
                    // 已经重试过 1 次，切换 key
                    shouldRotateKey = true;
                    messageRetryCount.delete(modelMessageId);
                    errorMessage += "\n\n[Retry failed, switching to next API key...]";
                    logService.warn(`Retry failed for message ${modelMessageId}, will rotate API key.`);
                }
            }
        } else {
            errorMessage = `${errorPrefix}: ${String(error)}`;
        }

        // 如果需要切换 key
        if (shouldRotateKey && appSettingsRef.current) {
            forceRotateApiKey(appSettingsRef.current);
        }

        // 如果不是重试，清理重试计数
        if (!shouldRetry) {
            messageRetryCount.delete(modelMessageId);
        }

        updateAndPersistSessions(prev => prev.map(s => s.id === sessionId ? { ...s, messages: s.messages.map(msg => 
            msg.id === modelMessageId 
                ? { 
                    ...msg, 
                    role: 'error', 
                    content: (msg.content || '').trim() + `\n\n[${errorMessage}]`, 
                    isLoading: false, 
                    generationEndTime: new Date() 
                  } 
                : msg
        )}: s));
    }, [updateAndPersistSessions]);

    return { handleApiError };
};
