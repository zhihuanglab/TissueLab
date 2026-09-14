import { COMMUNITY_API_ENDPOINT, CTRL_SERVICE_API_ENDPOINT } from "@/config/api.config";

// All endpoints below are getter functions so each call re-reads
// `CTRL_SERVICE_API_ENDPOINT` (an `export let` updated once Electron reports
// the local service port). A bare `const x = `${...}/...`` would freeze the
// value at module load.

/**
 * @user (local service)
 */
// anonymous user init
export const initUserEndpoint = () => `${CTRL_SERVICE_API_ENDPOINT}/users/v1/init_me`;
// init user assets
export const initUserAssetsEndpoint = () => `${CTRL_SERVICE_API_ENDPOINT}/users/v1/me`;
// update user profile
export const updateUserProfileEndpoint = () => `${CTRL_SERVICE_API_ENDPOINT}/users/v1/update_profile`;
// avatar endpoints
export const getUserAvatarEndpoint = (userId: string) => `${CTRL_SERVICE_API_ENDPOINT}/users/${userId}/avatar`;
export const uploadUserAvatarEndpoint = (userId: string) => `${CTRL_SERVICE_API_ENDPOINT}/users/${userId}/avatar`;
export const deleteUserAvatarEndpoint = (userId: string) => `${CTRL_SERVICE_API_ENDPOINT}/users/${userId}/avatar`;

/**
 * @auth (hosted TissueLab community server — issues the Firebase custom tokens)
 */
// email authentication endpoints
export const sendCodeEndpoint = () => `${COMMUNITY_API_ENDPOINT}/users/v1/send_code`;
export const verifyCodeEndpoint = () => `${COMMUNITY_API_ENDPOINT}/users/v1/verify_code`;
// Partner signed magic-link login (external institutes, e.g. HPAP)
export const partnerLoginEndpoint = () => `${COMMUNITY_API_ENDPOINT}/users/v1/partner_login`;
