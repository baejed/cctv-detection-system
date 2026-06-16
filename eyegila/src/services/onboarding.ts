import { request } from './api';

interface WizardProgress {
  step: string | null;
}

export const onboardingApi = {
  getProgress: () => request<WizardProgress>('/onboarding/progress'),
  setProgress: (step: string | null) =>
    request<WizardProgress>('/onboarding/progress', {
      method: 'PATCH',
      body: JSON.stringify({ step }),
    }),
};
