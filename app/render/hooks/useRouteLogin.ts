import { useSignupModal } from '@/store/zustand/store';

const useRouteLogin = () => {
  const setSignupModalOpen = useSignupModal((s) => s.setSignupModalOpen);
  const routerLogin = (signupSuccess?: () => void) =>
    setSignupModalOpen(true, { signupSuccess });

  return { routerLogin };
};

export default useRouteLogin;