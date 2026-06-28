import { useState, useEffect, useCallback } from 'react';
import { fetchOnboardingStatus, type OnboardingStatus } from '../api';

/**
 * 管理上手引导向导（Onboarding Wizard）的状态。
 *
 * 首次加载时自动调用 /api/onboarding/status 检查当前配置进度，供
 * OnboardingPage 与 Dashboard 顶部提示条共同消费。
 *
 * 设计与 useAuth / useWarRoom 风格保持一致：暴露 isLoading、状态对象、
 * 以及一个可手动触发的 checkStatus()。
 */
export function useOnboarding() {
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const checkStatus = useCallback(async (): Promise<OnboardingStatus | null> => {
    setIsLoading(true);
    setError(null);
    try {
      const status = await fetchOnboardingStatus();
      setOnboardingStatus(status);
      return status;
    } catch (err) {
      // 引导状态查询失败不应阻塞主流程——记录错误并视为未完成
      const message = err instanceof Error ? err.message : 'Failed to load onboarding status';
      setError(message);
      setOnboardingStatus(null);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 首次加载时自动检查状态
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetchOnboardingStatus()
      .then((status) => {
        if (!cancelled) setOnboardingStatus(status);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load onboarding status');
          setOnboardingStatus(null);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isComplete = onboardingStatus?.isComplete === true;

  return {
    onboardingStatus,
    isLoading,
    error,
    isComplete,
    checkStatus,
  };
}
