import { create, useStore } from 'zustand';

import { useSignupModalStore, SignupModalStore } from './slice/signupModal';

type AppStore = SignupModalStore

const useRootStore = create<AppStore>((...a) => ({
  ...useSignupModalStore(...a)
}));

export const useSignupModal = <Tab>(
  selector?: (state: SignupModalStore) => Tab
) => useStore(useRootStore, selector!);

export default useRootStore;