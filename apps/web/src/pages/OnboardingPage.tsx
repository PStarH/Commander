/**
 * OnboardingPage — 上手引导向导页面（路由 /onboarding）。
 *
 * 薄包装：将路由导航逻辑委托给 OnboardingWizard 组件。
 * 向导的步骤逻辑、状态管理、UI 全部在 OnboardingWizard 中实现，
 * 本页面只负责 "完成/跳过后的路由跳转"。
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { OnboardingWizard } from '../components/OnboardingWizard';

export function OnboardingPage() {
  const navigate = useNavigate();

  // 完成或跳过引导后，统一跳转到控制台首页
  const handleComplete = useCallback(() => {
    navigate('/');
  }, [navigate]);

  const handleSkip = useCallback(() => {
    navigate('/');
  }, [navigate]);

  return (
    <OnboardingWizard onComplete={handleComplete} onSkip={handleSkip} />
  );
}
