import { StateCreator, StoreApi } from 'zustand';

const initialState = {
  isSignupModalOpen: false,
  signupModalContext: null as null | {
    signupSuccess?: () => void;
    description?: string;
  },
};

type SignupModalState = typeof initialState;

type SignupModalAction = {
  setSignupModalOpen: (
    open: boolean,
    context?: { signupSuccess?: () => void; description?: string }
  ) => void;
};

export type SignupModalStore = SignupModalState & SignupModalAction;

const signupModalActions = (
  set: StoreApi<SignupModalStore>['setState'],
  get: StoreApi<SignupModalStore>['getState'],
  api: StoreApi<SignupModalStore>
): SignupModalAction => ({
  setSignupModalOpen: (open: boolean, context) =>
    set({ isSignupModalOpen: open, signupModalContext: context }),
});

export const useSignupModalStore: StateCreator<SignupModalStore> = (
  set,
  get,
  api
) => ({
  ...initialState,
  ...signupModalActions(set, get, api),
});