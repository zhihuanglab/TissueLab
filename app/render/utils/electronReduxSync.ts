import { Store, AnyAction } from 'redux';
import { RootState } from '@/store';

export function createStoreWithSynchronization(store: Store<RootState, AnyAction>): Store<RootState, AnyAction> {
  // Listen for actions dispatched from the main window
  // if (window.electron) {
  //   window.electron.on('redux-state-update', (event, action) => {
  //     // Apply the received action to this window's store
  //     store.dispatch(action);
  //   });
  //   // Intercept all dispatches to sync with main window
  //   const originalDispatch = store.dispatch;
  //   store.dispatch = ((action: AnyAction) => {
  //     // Send the action to main process to relay to other windows
  //     // window.electron.send('sync-redux-action', action);
  //     // Also apply it locally
  //     return originalDispatch(action);
  //   }) as typeof store.dispatch;
  // }

  return store;
} 