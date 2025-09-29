import { CTRL_SERVICE_API_ENDPOINT } from "@/constants/config";
const apiUrl = CTRL_SERVICE_API_ENDPOINT;

/**
 * @user
 */
// anonymous user init
export const initUserEndpoint = `${apiUrl}/users/v1/init_me`;
// init user assets
export const initUserAssetsEndpoint = `${apiUrl}/users/v1/me`;
// update user profile
export const updateUserProfileEndpoint = `${apiUrl}/users/v1/update_profile`;
// avatar endpoints
export const getUserAvatarEndpoint = (userId: string) => `${apiUrl}/users/${userId}/avatar`;
export const uploadUserAvatarEndpoint = (userId: string) => `${apiUrl}/users/${userId}/avatar`;
export const deleteUserAvatarEndpoint = (userId: string) => `${apiUrl}/users/${userId}/avatar`;


/**
 * @proprocessing
 */
// batch preprocessing
export const batchPreprocessingEndpoint = `${apiUrl}/preprocessing/v1/batch_preprocessing`;
