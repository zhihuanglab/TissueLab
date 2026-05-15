import { AI_SERVICE_API_ENDPOINT } from '@/constants/config';
import { apiFetch, payloadFromAxiosAppResponse, requireAxiosAppPayload } from '@/utils/common/apiFetch';

export interface PanelConfig {
  id: string;
  title: string;
  type: string;
  panel: Array<{
    key: string;
    type: string;
    value: any;
    label?: string;
    options?: any;
  }>;
  ui?: any;
}

export const panelService = {
  /**
   * Get panel configuration for a specific model
   */
  async getPanelConfig(modelName: string): Promise<PanelConfig | null> {
    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/get_panel_config/${modelName}`, {
        method: 'GET',
        returnAxiosFormat: true,
      });
      
      const d = payloadFromAxiosAppResponse<{ panel_config?: PanelConfig | null }>(response) ?? {};
      if (d.panel_config) {
        return d.panel_config;
      }

      return null;
    } catch (error) {
      console.error('Failed to get panel config:', error);
      return null;
    }
  },

  /**
   * Save panel configuration for a specific model
   */
  async savePanelConfig(modelName: string, panelConfig: PanelConfig): Promise<boolean> {
    try {
      const response = await apiFetch(`${AI_SERVICE_API_ENDPOINT}/tasks/v1/save_panel_config`, {
        method: 'POST',
        body: JSON.stringify({ model_name: modelName, panel_config: panelConfig }),
        returnAxiosFormat: true,
      });
      
      requireAxiosAppPayload(response);
      return true;
    } catch (error) {
      console.error('Failed to save panel config:', error);
      return false;
    }
  },

  /**
   * Check if a model has a custom panel
   */
  async hasCustomPanel(modelName: string): Promise<boolean> {
    const panelConfig = await this.getPanelConfig(modelName);
    return panelConfig !== null;
  }
};
