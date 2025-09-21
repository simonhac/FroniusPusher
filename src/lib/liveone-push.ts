import axios from 'axios';
import { FroniusMinutely } from '@/types/fronius';

interface LiveOnePushConfig {
  apiKey: string | null;
  apiUrl: string | null;
  enabled: boolean;
}


export class LiveOnePushService {
  private config: LiveOnePushConfig;
  private lastPushTimestamp?: Date;
  private initialized: boolean = false;
  
  constructor() {
    // Set initial config to disabled until initialization completes
    this.config = {
      apiKey: null,
      apiUrl: null,
      enabled: false
    };
    this.initialize();
  }
  
  private async initialize() {
    const apiKey = process.env.LIVEONE_API_KEY;
    const server = process.env.LIVEONE_SERVER;
    const enabledStr = process.env.LIVEONE_ENABLED;
    
    // Check if any LiveOne env vars are set
    const anyVarSet = apiKey !== undefined || server !== undefined || enabledStr !== undefined;
    
    if (anyVarSet) {
      // If any are set, validate all required ones
      const errors: string[] = [];
      
      // Check LIVEONE_ENABLED
      if (enabledStr === undefined) {
        errors.push('LIVEONE_ENABLED is not set (must be "true" or "false")');
      } else if (enabledStr !== 'true' && enabledStr !== 'false') {
        errors.push('LIVEONE_ENABLED must be "true" or "false"');
      }
      
      // Check LIVEONE_API_KEY
      if (!apiKey) {
        errors.push('LIVEONE_API_KEY is not set');
      } else if (!apiKey.startsWith('fr_')) {
        errors.push('LIVEONE_API_KEY must start with "fr_"');
      }
      
      // Check LIVEONE_SERVER
      if (!server) {
        errors.push('LIVEONE_SERVER is not set');
      } else if (!server.toLowerCase().startsWith('http://') && !server.toLowerCase().startsWith('https://')) {
        errors.push('LIVEONE_SERVER must start with http:// or https://');
      }
      
      if (errors.length > 0) {
        console.error('[LiveOne] Configuration errors:');
        errors.forEach(err => console.error(`  - ${err}`));
        console.error('[LiveOne] LiveOne push service will be disabled.');
        
        // Disable the service if there are configuration errors
        this.config = {
          apiKey: apiKey || null,
          apiUrl: server ? `${server}/api/push/fronius` : null,
          enabled: false
        };
      } else {
        // All validation passed, construct the URL
        const apiUrl = `${server}/api/push/fronius`;
        
        this.config = {
          apiKey: apiKey!,
          apiUrl: apiUrl,
          enabled: enabledStr === 'true'
        };
        
        if (this.config.enabled) {
          console.log('[LiveOne] Push service initialized');
          console.log(`[LiveOne] Server: ${server}`);
        } else {
          console.log('[LiveOne] Push service configured but not enabled');
        }
      }
    } else {
      // No LiveOne env vars set at all - this is fine, just disable
      this.config = {
        apiKey: null,
        apiUrl: null,
        enabled: false
      };
      console.log('[LiveOne] No configuration found - service disabled');
    }
    
    this.initialized = true;
  }
  
  public isEnabled(): boolean {
    return this.config.enabled;
  }
  
  public async pushFroniusMinutely(data: FroniusMinutely): Promise<void> {
    if (!this.isEnabled() || !this.config.apiKey || !this.config.apiUrl) {
      return;
    }
    
    try {
      // FroniusMinutely already has all fields in the right format
      // Just add API key and action
      const payload = {
        ...data,  // Spread all FroniusMinutely fields
        apiKey: this.config.apiKey,
        action: 'store'
      };
      
      const response = await axios.post(this.config.apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 10000, // 10 second timeout
      });
      
      if (response.data.success) {
        this.lastPushTimestamp = new Date(data.timestamp);
        
        // Create condensed log with key metrics
        const solarKw = (data.solarW / 1000).toFixed(1);
        const batteryKw = (Math.abs(data.batteryW) / 1000).toFixed(1);
        const batteryDirection = data.batteryW > 0 ? '+' : data.batteryW < 0 ? '-' : '';
        const gridKw = (Math.abs(data.gridW) / 1000).toFixed(1);
        const gridDirection = data.gridW > 0 ? ' import' : data.gridW < 0 ? ' export' : '';
        const loadKw = (data.loadW / 1000).toFixed(1);
        const soc = data.batterySOC !== null ? `/${data.batterySOC.toFixed(1)}%` : '';
        
        // Extract hostname from URL for cleaner display
        const urlObj = new URL(this.config.apiUrl);
        const hostname = urlObj.hostname === 'localhost' ? `${urlObj.hostname}:${urlObj.port}` : urlObj.hostname;
        
        console.log(`${data.timestamp} ${data.sequence} pushed to ${hostname}: solar: ${solarKw}kW, battery: ${batteryDirection}${batteryKw}kW${soc}, grid: ${gridKw}kW${gridDirection}, load: ${loadKw}kW`);
      } else {
        console.error('[LiveOne] Push failed:', response.data);
      }
      
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          const status = error.response.status;
          const errorData = error.response.data;
          
          switch (status) {
            case 400:
              console.error('[LiveOne] Bad request - missing required fields:', errorData);
              break;
            case 401:
              console.error('[LiveOne] Invalid API key. Check LIVEONE_API_KEY configuration.');
              this.config.enabled = false; // Disable to prevent repeated auth failures
              break;
            case 404:
              console.error('[LiveOne] System not found.');
              this.config.enabled = false; // Disable to prevent repeated 404s
              break;
            case 409:
              // Duplicate timestamp - this is normal if restarting
              console.log('[LiveOne] Duplicate timestamp - data already exists for:', data.timestamp);
              break;
            default:
              console.error('[LiveOne] Server error:', status, errorData);
          }
        } else if (error.request) {
          console.error('[LiveOne] Network error - no response received:', error.message);
        } else {
          console.error('[LiveOne] Request setup error:', error.message);
        }
      } else {
        console.error('[LiveOne] Unexpected error:', error);
      }
    }
  }
  
  public getLastPushTimestamp(): Date | undefined {
    return this.lastPushTimestamp;
  }
  
  public getStatus(): { enabled: boolean; configured: boolean; lastPush?: Date } {
    return {
      enabled: this.config.enabled,
      configured: !!this.config.apiKey,
      lastPush: this.lastPushTimestamp
    };
  }
  
  public async testConnection(): Promise<{ success: boolean; message: string; url?: string; details?: any }> {
    if (!this.config.apiKey || !this.config.apiUrl) {
      return {
        success: false,
        message: 'LiveOne not configured - missing API key or server URL'
      };
    }
    
    try {
      const payload = {
        apiKey: this.config.apiKey,
        action: 'test'
      };
      
      const response = await axios.post(this.config.apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 5000, // 5 second timeout for test
      });
      
      if (response.data.success) {
        const displayName = response.data.displayName || 'Unknown System';
        console.log(`[LiveOne] Connection to ${this.config.apiUrl} is live (displayName: '${displayName}')`);
      } else {
        console.log(`[LiveOne] Connection to ${this.config.apiUrl} failed (${response.data.message || 'Unknown error'})`);
      }
      
      return {
        success: true,
        message: 'Connection test successful',
        url: this.config.apiUrl,
        details: response.data
      };
      
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        if (error.response) {
          const status = error.response.status;
          const errorData = error.response.data;
          
          console.log(`[LiveOne] Connection to ${this.config.apiUrl} failed (status ${status})`);
          
          return {
            success: false,
            message: `Test failed with status ${status}`,
            url: this.config.apiUrl,
            details: errorData
          };
        } else if (error.request) {
          // Network error - no response received (timeout, DNS failure, connection refused, etc.)
          let errorType = 'no response';
          if (error.code === 'ENOTFOUND') {
            errorType = 'DNS resolution failed';
          } else if (error.code === 'ECONNREFUSED') {
            errorType = 'connection refused';
          } else if (error.code === 'TIMEOUT' || error.message.includes('timeout')) {
            errorType = 'timeout';
          }
          
          console.log(`[LiveOne] Connection to ${this.config.apiUrl} failed (${errorType})`);
          return {
            success: false,
            message: `Network error - ${errorType}`,
            url: this.config.apiUrl,
            details: error.message
          };
        } else {
          console.log(`[LiveOne] Connection to ${this.config.apiUrl} failed (${error.message})`);
          return {
            success: false,
            message: 'Request setup error',
            url: this.config.apiUrl,
            details: error.message
          };
        }
      } else {
        console.log(`[LiveOne] Connection to ${this.config.apiUrl} failed (${error.message})`);
        return {
          success: false,
          message: 'Unexpected error during test',
          url: this.config.apiUrl,
          details: error.message
        };
      }
    }
  }
}