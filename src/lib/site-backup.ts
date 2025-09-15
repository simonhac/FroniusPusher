import { discoverFroniusInverters } from './fronius-discovery';
import axios from 'axios';
import EventEmitter from 'events';
import { isFaultStatus } from './fronius-status-codes';
import { EnergyIntegrator, BidirectionalEnergyIntegrator } from './energy-integrator';
import { FroniusMinutely } from '@/types/fronius';
import { formatLocalDateTime } from './date-utils';

interface BatteryInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  capacityWh?: number;  // Capacity_Maximum in Wh
  enabled?: boolean;
}

// Map device type codes to model names
const DEVICE_TYPE_MAP: Record<number, string> = {
  1: 'Gen24',
  // Add more mappings as we discover them
};

interface InverterInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  pvPowerW?: number;  // Installed PV power capacity (DC)
  customName?: string;  // User-defined name
}

interface MeterInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  location?: string;  // 'grid', 'load', 'subload', etc.
  enabled?: boolean;
}

interface FroniusDevice {
  ip: string;
  mac: string;
  hostname?: string;
  isMaster: boolean;
  serialNumber: string;
  data?: any;
  info?: {
    CustomName?: string;
    DT?: number;
    StatusCode?: number;
  };
  battery?: BatteryInfo;  // Battery information if available
  inverterInfo?: InverterInfo;  // Inverter specifications
  meter?: MeterInfo;  // Power meter information if available
  lastUpdated?: Date;
  lastDataFetch?: Date;
}

interface HistoricalDataPoint {
  timestamp: Date;
  solarW?: number;
  batteryW?: number;
  gridW?: number;
  loadW?: number;  // Calculated load from site
  batterySoC?: number;
}

export interface InverterDevice {
  serialNumber: string;
  ip: string;
  hostname?: string;
  isMaster: boolean;
  name: string;
  battery?: BatteryInfo;  // Battery information
  inverterInfo?: InverterInfo;  // Inverter specifications
  meter?: MeterInfo;  // Power meter information
  
  // Energy integrators (null until capability is found)
  solarIntegrator: EnergyIntegrator | null;
  batteryIntegrator: BidirectionalEnergyIntegrator | null;
  gridIntegrator: BidirectionalEnergyIntegrator | null;
  
  // Current power values in watts
  currentPower: {
    solarW?: number;
    batteryW?: number;
    gridW?: number;
    batterySoC?: number;
  };
  
  // Latest data from API
  lastData?: any;
  lastDataFetch?: Date;
  faultCode?: string | number;
  faultTimestamp?: Date;
}

export class Site extends EventEmitter {
  private name: string;
  private inverters: Map<string, InverterDevice> = new Map();
  private devices: Map<string, FroniusDevice> = new Map();  // Cache for discovered devices
  private sessionId: string;
  private sequenceNumber: number = 0;
  private lastEnergySnapshot: Map<string, any> = new Map();
  private froniusMinutelyHistory: FroniusMinutely[] = [];
  private historicalData: Map<string, HistoricalDataPoint[]> = new Map();
  
  // Polling and scanning state
  private pollingInterval: NodeJS.Timeout | null = null;
  private energyDeltaInterval: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;
  private lastScan: Date | null = null;
  
  constructor(name: string = 'Main Site') {
    super();
    this.name = name;
    this.sessionId = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0').toUpperCase();
    
    // Log server startup info
    console.log('================================================');
    console.log('Fronius Site Manager initialised');
    console.log(`Server running on port: ${process.env.PORT || 8080}`);
    console.log('================================================');
    
    // Start automatic polling
    this.startPolling();
    
    // Start energy delta reporting (once per minute)
    this.startEnergyDeltaReporting();
    
    // Schedule initial scan
    setImmediate(() => {
      const shouldInitialScan = this.devices.size === 0 || 
        !this.lastScan || 
        (Date.now() - this.lastScan.getTime() > 60 * 60 * 1000);
      
      if (shouldInitialScan) {
        console.log('Initiating initial device scan...');
        this.scanDevices();
      } else {
        console.log(`Using cached devices (${this.devices.size} devices, last scan: ${this.lastScan?.toLocaleTimeString()})`);
      }
    });
  }
  
  private startPolling() {
    // Poll every 2 seconds
    this.pollingInterval = setInterval(() => {
      this.updateAllDeviceData();
    }, 2 * 1000);
  }
  
  public stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    if (this.energyDeltaInterval) {
      clearTimeout(this.energyDeltaInterval);
      this.energyDeltaInterval = null;
    }
  }
  
  private startEnergyDeltaReporting() {
    // Schedule reports at 5 seconds past each minute
    const scheduleNextReport = () => {
      const now = new Date();
      const currentSeconds = now.getSeconds();
      
      // If we're at or past 5 seconds, run immediately and schedule for next minute
      if (currentSeconds >= 5) {
        this.reportMinutely();
        
        // Calculate delay until 5 seconds past the next minute
        const nextMinute = new Date(now);
        nextMinute.setMinutes(nextMinute.getMinutes() + 1);
        nextMinute.setSeconds(5);
        nextMinute.setMilliseconds(0);
        const delay = nextMinute.getTime() - now.getTime();
        
        this.energyDeltaInterval = setTimeout(() => {
          scheduleNextReport();
        }, delay);
      } else {
        // We're before 5 seconds, wait until 5 seconds of this minute
        const targetTime = new Date(now);
        targetTime.setSeconds(5);
        targetTime.setMilliseconds(0);
        const delay = targetTime.getTime() - now.getTime();
        
        this.energyDeltaInterval = setTimeout(() => {
          scheduleNextReport();
        }, delay);
      }
    };
    
    // Start the scheduling
    scheduleNextReport();
  }
  
  private reportMinutely() {
    // Generate FroniusMinutely report
    const froniusMinutely = this.generateFroniusMinutely();
    
    if (froniusMinutely) {
      // Emit FroniusMinutely object
      this.emit('froniusMinutely', froniusMinutely);
    }
  }
  
  // Helper methods to fetch detailed device information during discovery
  private async fetchBatteryInfo(ip: string): Promise<BatteryInfo | undefined> {
    try {
      const response = await axios.get(`http://${ip}/solar_api/v1/GetStorageRealtimeData.cgi`, {
        timeout: 2000
      });
      
      // Check for controller in Data["0"].Controller structure (newer API)
      const controller = response.data?.Body?.Data?.["0"]?.Controller;
      if (controller) {
        return {
          manufacturer: controller.Details?.Manufacturer,
          model: controller.Details?.Model,
          serial: controller.Details?.Serial?.trim(), // Trim whitespace from serial
          capacityWh: controller.Capacity_Maximum,
          enabled: controller.Enable === 1
        };
      }
      
      // Fallback to check for controller in Data.Controller[0] structure (older API)
      const altController = response.data?.Body?.Data?.Controller?.[0];
      if (altController) {
        return {
          manufacturer: altController.Details?.Manufacturer,
          model: altController.Details?.Model,
          serial: altController.Details?.Serial?.trim(),
          capacityWh: altController.Capacity_Maximum,
          enabled: altController.Enable === 1
        };
      }
    } catch (error: any) {
      // No battery or error fetching battery info - this is normal for devices without batteries
      console.log(`No battery found on ${ip}`);
    }
    return undefined;
  }

  private async fetchInverterInfo(ip: string): Promise<InverterInfo | undefined> {
    try {
      const response = await axios.get(`http://${ip}/solar_api/v1/GetInverterInfo.cgi`, {
        timeout: 2000
      });
      
      const inverterData = response.data?.Body?.Data;
      if (inverterData) {
        // Get the first inverter (usually key "1")
        const firstInverter = Object.values(inverterData)[0] as any;
        if (firstInverter) {
          // Map device type to model name
          const deviceType = firstInverter.DT;
          const modelName = deviceType && DEVICE_TYPE_MAP[deviceType] 
            ? DEVICE_TYPE_MAP[deviceType]
            : (firstInverter.Type || `Unknown (DT: ${deviceType})`);
          
          return {
            manufacturer: 'Fronius',
            model: modelName,
            serial: firstInverter.UniqueID,
            pvPowerW: firstInverter.PVPower,
            customName: firstInverter.CustomName
          };
        }
      }
    } catch (error) {
      console.log(`Error fetching inverter info from ${ip}:`, error);
    }
    return undefined;
  }

  private async fetchMeterInfo(ip: string): Promise<MeterInfo | undefined> {
    try {
      const response = await axios.get(`http://${ip}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`, {
        timeout: 2000
      });
      
      const meterData = response.data?.Body?.Data;
      if (meterData && Object.keys(meterData).length > 0) {
        // Get the first meter
        const firstMeter = Object.values(meterData)[0] as any;
        if (firstMeter) {
          // Translate meter location codes according to Fronius documentation
          const locationCode = firstMeter.Meter_Location_Current;
          let location = 'Unknown';
          
          if (locationCode === 0) {
            location = 'Grid (feed-in point)';
          } else if (locationCode === 1) {
            location = 'Load (consumption)';
          } else if (locationCode === 3) {
            location = 'External generator';
          } else if (locationCode >= 256 && locationCode <= 511) {
            // Subload range
            const subloadNumber = locationCode - 255;
            location = `Subload #${subloadNumber}`;
          } else if (locationCode >= 512 && locationCode <= 768) {
            // EV Charger range
            const evNumber = locationCode - 511;
            location = `EV Charger #${evNumber}`;
          } else if (locationCode >= 769 && locationCode <= 1023) {
            // Storage range
            const storageNumber = locationCode - 768;
            location = `Storage #${storageNumber}`;
          } else {
            location = `Unknown (code ${locationCode})`;
          }
          
          // Correct manufacturer for CCS meters
          let manufacturer = firstMeter.Details?.Manufacturer;
          const model = firstMeter.Details?.Model;
          if (model && model.startsWith('CCS')) {
            manufacturer = 'Continental Control Systems';
          }
          
          return {
            manufacturer: manufacturer,
            model: model,
            serial: firstMeter.Details?.Serial,
            location: location,
            enabled: firstMeter.Enable === 1
          };
        }
      }
    } catch (error) {
      // No meter or error fetching meter info
      console.log(`No meter found on ${ip}`);
    }
    return undefined;
  }

  public async scanDevices(): Promise<void> {
    if (this.isScanning) {
      console.log('Scan already in progress, skipping...');
      this.emit('scanStatus', { status: 'already_scanning', message: 'Scan already in progress' });
      return;
    }
    
    this.isScanning = true;
    this.lastScan = new Date();
    
    // Emit scan started event
    this.emit('scanStatus', { status: 'started', message: 'Starting network scan...' });
    
    try {
      console.log('Starting device scan...');
      this.emit('scanStatus', { status: 'scanning', message: 'Scanning network for Fronius devices...' });
      
      const discoveredDevices = await discoverFroniusInverters();
      
      // Emit found devices count
      this.emit('scanStatus', { 
        status: 'found', 
        message: `Found ${discoveredDevices.length} device(s)`,
        count: discoveredDevices.length 
      });
      
      // Update device cache and inverters with detailed information
      for (const device of discoveredDevices) {
        console.log(`Fetching detailed info for ${device.ip}...`);
        
        // Fetch detailed information during discovery only
        const [batteryInfo, inverterInfo, meterInfo] = await Promise.all([
          this.fetchBatteryInfo(device.ip),
          this.fetchInverterInfo(device.ip),
          this.fetchMeterInfo(device.ip)
        ]);
        
        const existingDevice = this.devices.get(device.serialNumber);
        const updatedDevice: FroniusDevice = {
          ...device,
          battery: batteryInfo,
          inverterInfo: inverterInfo,
          meter: meterInfo,
          lastUpdated: new Date(),
          lastDataFetch: existingDevice?.lastDataFetch
        };
        
        this.devices.set(device.serialNumber, updatedDevice);
        
        // Log discovered capabilities
        if (batteryInfo) {
          console.log(`  - Battery: ${batteryInfo.manufacturer} ${batteryInfo.model}, Capacity: ${(batteryInfo.capacityWh || 0) / 1000}kWh`);
        }
        if (inverterInfo) {
          console.log(`  - Inverter: ${inverterInfo.model}, PV: ${(inverterInfo.pvPowerW || 0) / 1000}kW`);
        }
        if (meterInfo) {
          console.log(`  - Meter: ${meterInfo.manufacturer} ${meterInfo.model} at ${meterInfo.location}`);
        }
        
        // Create or update InverterDevice
        let inverterDevice = this.inverters.get(device.serialNumber);
        if (!inverterDevice) {
          inverterDevice = {
            serialNumber: device.serialNumber,
            ip: device.ip,
            hostname: device.hostname,
            isMaster: device.isMaster,
            name: device.info?.CustomName || device.hostname?.split('.')[0] || device.ip,
            battery: batteryInfo,
            inverterInfo: inverterInfo,
            meter: meterInfo,
            solarIntegrator: new EnergyIntegrator(),
            batteryIntegrator: batteryInfo ? new BidirectionalEnergyIntegrator() : null,  // Only create if battery exists
            gridIntegrator: device.isMaster ? new BidirectionalEnergyIntegrator() : null,
            currentPower: {},
            lastData: undefined,
            lastDataFetch: undefined
          };
          this.inverters.set(device.serialNumber, inverterDevice);
        } else {
          // Update existing device with new discovery info
          inverterDevice.battery = batteryInfo;
          inverterDevice.inverterInfo = inverterInfo;
          inverterDevice.meter = meterInfo;
          // Only create battery integrator if we discovered a battery and don't have one yet
          if (batteryInfo && !inverterDevice.batteryIntegrator) {
            inverterDevice.batteryIntegrator = new BidirectionalEnergyIntegrator();
          }
        }
      }
      
      // Remove devices that are no longer discovered
      const discoveredSerials = new Set(discoveredDevices.map(d => d.serialNumber));
      for (const [serialNumber] of this.devices.entries()) {
        if (!discoveredSerials.has(serialNumber)) {
          this.devices.delete(serialNumber);
          this.inverters.delete(serialNumber);
        }
      }
      
      console.log(`Scan complete. Found ${this.devices.size} devices.`);
      
      // Emit scan complete
      this.emit('scanStatus', { 
        status: 'completed', 
        message: `Scan complete. Found ${this.devices.size} device(s)`,
        count: this.devices.size 
      });
      
      // Fetch data for all devices after scan (this will emit siteUpdate)
      await this.updateAllDeviceData();
    } catch (error) {
      console.error('Error during device scan:', error);
      this.emit('scanStatus', { 
        status: 'error', 
        message: 'Error during scan',
        error: error instanceof Error ? error.message : 'Unknown error' 
      });
    } finally {
      this.isScanning = false;
    }
  }
  
  private async updateAllDeviceData(): Promise<void> {
    const startTime = Date.now();
    const updatePromises: Promise<void>[] = [];
    
    for (const [serialNumber, device] of this.devices.entries()) {
      updatePromises.push(this.updateDeviceData(device.ip, false)); // false = don't emit individual updates
    }
    
    // Wait for all devices to update
    await Promise.all(updatePromises);
    
    // Now emit a single site update with all device data
    const siteInfo = this.getSiteInfo();
    this.emit('siteUpdate', siteInfo);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // console.log(`${this.devices.size} devices updated in ${duration}s`);
  }
  
  private async updateDeviceData(ip: string, emitUpdate: boolean = true): Promise<void> {
    try {
      // Find device by IP
      let device: FroniusDevice | undefined;
      let deviceSerialNumber: string | undefined;
      for (const [serialNumber, d] of this.devices.entries()) {
        if (d.ip === ip) {
          device = d;
          deviceSerialNumber = serialNumber;
          break;
        }
      }
      if (!device || !deviceSerialNumber) return;
      
      // Fetch multiple endpoints in parallel with 2 second timeout
      const [powerFlowResponse, inverterResponse, meterResponse] = await Promise.allSettled([
        axios.get(`http://${ip}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`, { timeout: 2000 }),
        axios.get(`http://${ip}/solar_api/v1/GetInverterRealtimeData.cgi?Datacollection=CumulationInverterData`, { timeout: 2000 }),
        axios.get(`http://${ip}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`, { timeout: 2000 })
      ]);
      
      if (powerFlowResponse.status === 'fulfilled' && powerFlowResponse.value.data) {
        device.data = powerFlowResponse.value.data;
        device.lastDataFetch = new Date();
        this.devices.set(device.serialNumber, device);
        
        // Update InverterDevice data
        const inverterDevice = this.inverters.get(device.serialNumber);
        if (inverterDevice) {
          inverterDevice.lastData = powerFlowResponse.value.data;
          inverterDevice.lastDataFetch = new Date();
        }
        
        // Store historical data
        if (powerFlowResponse.value.data?.Body?.Data?.Site) {
          const site = powerFlowResponse.value.data.Body.Data.Site;
          const inverters = powerFlowResponse.value.data.Body.Data.Inverters;
          const firstInverter = inverters && Object.values(inverters)[0] as any;
          
          // Calculate load for this specific inverter's data
          let loadW: number | undefined = undefined;
          if (site.P_PV !== undefined && site.P_Grid !== undefined && site.P_Akku !== undefined) {
            // Load = Solar + Grid Import - Grid Export + Battery Discharge - Battery Charge
            // P_Grid > 0 means importing, P_Akku < 0 means charging
            loadW = Math.round((site.P_PV || 0) + (site.P_Grid || 0) + (site.P_Akku || 0));
            loadW = Math.max(0, loadW); // Load can't be negative
          }
          
          const dataPoint: HistoricalDataPoint = {
            timestamp: new Date(),
            solarW: site.P_PV !== null && site.P_PV !== undefined ? Math.round(site.P_PV) : undefined,
            batteryW: site.P_Akku !== null && site.P_Akku !== undefined ? Math.round(site.P_Akku) : undefined,
            gridW: site.P_Grid !== null && site.P_Grid !== undefined ? Math.round(site.P_Grid) : undefined,
            loadW: loadW,
            batterySoC: firstInverter?.SOC !== null && firstInverter?.SOC !== undefined ? Math.round(firstInverter.SOC) : undefined
          };
          
          // Get or create history array for this device
          const history = this.historicalData.get(device.serialNumber) || [];
          history.push(dataPoint);
          
          // Keep only last 10 minutes of data (300 samples at 2-second polling)
          if (history.length > 300) {
            history.shift();
          }
          
          this.historicalData.set(device.serialNumber, history);
        }
        
        // Update energy integrators
        this.updateEnergyIntegrators(ip, powerFlowResponse.value.data,
          inverterResponse.status === 'fulfilled' ? inverterResponse.value.data : null,
          meterResponse.status === 'fulfilled' ? meterResponse.value.data : null);
        
        // Only emit individual device updates if requested (not during batch polling)
        if (emitUpdate) {
          this.emit('deviceDataUpdated', {
            ip,
            serialNumber: deviceSerialNumber,
            data: powerFlowResponse.value.data,
            timestamp: new Date()
          });
        }
      }
      
      // Clear fault code if everything is successful
      const inverterDevice = this.inverters.get(device.serialNumber);
      if (inverterDevice) {
        delete inverterDevice.faultCode;
        delete inverterDevice.faultTimestamp;
      }
    } catch (error) {
      console.error(`Error fetching data for ${ip}:`, error);
      
      // Find device by IP to get serial number
      let serialNumber = ip;
      for (const [sn, d] of this.devices.entries()) {
        if (d.ip === ip) {
          serialNumber = sn;
          break;
        }
      }
      
      // Track error in inverter device
      const inverterDevice = this.inverters.get(serialNumber);
      if (inverterDevice) {
        // Set fault code based on error type
        if (axios.isAxiosError(error)) {
          if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
            inverterDevice.faultCode = 'TIMEOUT';
          } else if (error.response) {
            inverterDevice.faultCode = `HTTP_${error.response.status}`;
          } else if (error.code === 'ECONNREFUSED') {
            inverterDevice.faultCode = 'CONNECTION_REFUSED';
          } else if (error.code === 'EHOSTUNREACH') {
            inverterDevice.faultCode = 'HOST_UNREACHABLE';
          } else {
            inverterDevice.faultCode = error.code || 'NETWORK_ERROR';
          }
        } else {
          inverterDevice.faultCode = 'UNKNOWN_ERROR';
        }
        
        inverterDevice.faultTimestamp = new Date();
      }
    }
  }
  
  private updateEnergyIntegrators(ip: string, powerFlowData: any, inverterData: any, meterData: any): void {
    // Find device by IP to get serial number
    let device: FroniusDevice | undefined;
    let serialNumber: string | undefined;
    for (const [sn, d] of this.devices.entries()) {
      if (d.ip === ip) {
        device = d;
        serialNumber = sn;
        break;
      }
    }
    if (!device || !serialNumber) return;
    
    // Get the InverterDevice
    const inverterDevice = this.inverters.get(serialNumber);
    if (!inverterDevice) return;
    
    const now = new Date();
    
    // Set initial hardware counter values if available
    if (inverterData?.Body?.Data?.TOTAL_ENERGY?.Values?.['1'] !== undefined && inverterDevice.solarIntegrator) {
      inverterDevice.solarIntegrator.setInitialHardwareCounter(inverterData.Body.Data.TOTAL_ENERGY.Values['1']);
      inverterDevice.solarIntegrator.updateHardwareCounter(inverterData.Body.Data.TOTAL_ENERGY.Values['1']);
    }
    
    // Update integrators with current power values
    if (powerFlowData?.Body?.Data?.Site) {
      const site = powerFlowData.Body.Data.Site;
      const inverters = powerFlowData.Body.Data.Inverters;
      const firstInverter = inverters && Object.values(inverters)[0] as any;
      
      // Update current power values
      inverterDevice.currentPower = {
        solarW: site.P_PV ?? undefined,
        batteryW: site.P_Akku ?? undefined,
        gridW: site.P_Grid ?? undefined,
        batterySoC: firstInverter?.SOC ?? undefined
      };
      
      // Update integrators
      if (inverterDevice.solarIntegrator && site.P_PV !== undefined && site.P_PV !== null) {
        inverterDevice.solarIntegrator.updatePower(site.P_PV, now);
      }
      
      if (inverterDevice.batteryIntegrator && site.P_Akku !== undefined && site.P_Akku !== null) {
        inverterDevice.batteryIntegrator.updatePower(site.P_Akku, now);
      }
      
      if (inverterDevice.gridIntegrator && site.P_Grid !== undefined && site.P_Grid !== null) {
        inverterDevice.gridIntegrator.updatePower(site.P_Grid, now);
      }
    }
  }
  
  // Inverter management methods
  public getInverter(serialNumber: string): InverterDevice | undefined {
    return this.inverters.get(serialNumber);
  }
  
  public getInverters(): InverterDevice[] {
    return Array.from(this.inverters.values());
  }
  
  public getMasterInverters(): InverterDevice[] {
    return this.getInverters().filter(inv => inv.isMaster);
  }
  
  public getSlaveInverters(): InverterDevice[] {
    return this.getInverters().filter(inv => !inv.isMaster);
  }
  
  // Device management methods
  public getDevices(): FroniusDevice[] {
    return Array.from(this.devices.values());
  }
  
  public getDevice(serialNumber: string): FroniusDevice | undefined {
    return this.devices.get(serialNumber);
  }
  
  public async fetchDeviceData(ip: string): Promise<any> {
    await this.updateDeviceData(ip, true); // true = emit individual update
    for (const [serialNumber, device] of this.devices.entries()) {
      if (device.ip === ip) {
        return device.data;
      }
    }
    return undefined;
  }
  
  // Power calculation methods
  public calculateLoadPowerW(): number | null {
    if (this.inverters.size === 0) {
      return null;
    }
    
    let totalSolar = 0;
    let totalBatteryPower = 0;
    let totalGridPower = 0;
    let hasData = false;
    
    for (const inverter of this.inverters.values()) {
      if (inverter.currentPower.solarW !== undefined) {
        totalSolar += inverter.currentPower.solarW;
        hasData = true;
      }
      
      if (inverter.currentPower.batteryW !== undefined) {
        totalBatteryPower += inverter.currentPower.batteryW;
        hasData = true;
      }
      
      if (inverter.currentPower.gridW !== undefined) {
        totalGridPower += inverter.currentPower.gridW;
        hasData = true;
      }
    }
    
    if (!hasData) {
      return null;
    }
    
    const loadPower = totalSolar + totalBatteryPower + totalGridPower;
    return Math.max(0, loadPower);
  }
  
  public getTotalSolarPowerW(): number | null {
    if (this.inverters.size === 0) return null;
    
    return this.getInverters().reduce((sum, inv) => 
      sum + (inv.currentPower.solarW || 0), 0);
  }
  
  public getTotalBatteryPowerW(): number | null {
    if (this.inverters.size === 0) return null;
    return this.getInverters().reduce((sum, inv) => 
      sum + (inv.currentPower.batteryW || 0), 0);
  }
  
  public getTotalGridPowerW(): number | null {
    const masters = this.getMasterInverters();
    if (masters.length === 0) return null;
    return masters[0].currentPower.gridW || 0;
  }
  
  public getBatterySOC(): number | null {
    const socValues = this.getInverters()
      .map(inv => inv.currentPower.batterySoC)
      .filter(soc => soc !== undefined && soc !== null);
    
    if (socValues.length === 0) return null;
    
    return socValues.reduce((sum, soc) => sum + soc, 0) / socValues.length;
  }
  
  // Energy totals in Wh
  public getEnergyTotals(): {
    solarWh: number | null;
    batteryInWh: number | null;
    batteryOutWh: number | null;
    gridInWh: number | null;
    gridOutWh: number | null;
    loadWh: number | null;
  } {
    if (this.inverters.size === 0) {
      return {
        solarWh: null,
        batteryInWh: null,
        batteryOutWh: null,
        gridInWh: null,
        gridOutWh: null,
        loadWh: null
      };
    }
    
    let totals = {
      solarWh: 0,
      batteryInWh: 0,
      batteryOutWh: 0,
      gridInWh: 0,
      gridOutWh: 0,
      loadWh: 0
    };
    
    let hasSolar = false;
    let hasBattery = false;
    let hasGrid = false;
    
    for (const inverter of this.inverters.values()) {
      if (inverter.solarIntegrator) {
        totals.solarWh += inverter.solarIntegrator.getTotalKwh() * 1000; // Convert kWh to Wh
        hasSolar = true;
      }
      
      if (inverter.batteryIntegrator) {
        totals.batteryOutWh += inverter.batteryIntegrator.getPositiveKwh() * 1000; // Convert kWh to Wh
        totals.batteryInWh += inverter.batteryIntegrator.getNegativeKwh() * 1000; // Convert kWh to Wh
        hasBattery = true;
      }
      
      if (inverter.isMaster && inverter.gridIntegrator) {
        totals.gridInWh += inverter.gridIntegrator.getPositiveKwh() * 1000; // Convert kWh to Wh
        totals.gridOutWh += inverter.gridIntegrator.getNegativeKwh() * 1000; // Convert kWh to Wh
        hasGrid = true;
      }
    }
    
    const hasLoad = hasSolar || hasGrid || hasBattery;
    if (hasLoad) {
      totals.loadWh = totals.solarWh + totals.gridInWh + totals.batteryOutWh - totals.gridOutWh - totals.batteryInWh;
      totals.loadWh = Math.max(0, totals.loadWh);
    }
    
    return {
      solarWh: hasSolar ? totals.solarWh : null,
      batteryInWh: hasBattery ? totals.batteryInWh : null,
      batteryOutWh: hasBattery ? totals.batteryOutWh : null,
      gridInWh: hasGrid ? totals.gridInWh : null,
      gridOutWh: hasGrid ? totals.gridOutWh : null,
      loadWh: hasLoad ? totals.loadWh : null
    };
  }
  
  // Status and info methods
  public getStatus() {
    return {
      deviceCount: this.devices.size,
      lastScan: this.lastScan,
      isScanning: this.isScanning,
      devices: this.getDevices(),
      site: this.getSiteInfo()
    };
  }
  
  public getSiteInfo() {
    // Get devices with energy counters added
    const devicesWithEnergy = this.getDevices().map(device => {
      const inverterDevice = this.inverters.get(device.serialNumber);
      const energyCounters = inverterDevice ? {
        solarWh: (inverterDevice.solarIntegrator?.getTotalKwh() ?? 0) * 1000,
        batteryInWh: (inverterDevice.batteryIntegrator?.getNegativeKwh() ?? 0) * 1000,
        batteryOutWh: (inverterDevice.batteryIntegrator?.getPositiveKwh() ?? 0) * 1000,
        gridInWh: (inverterDevice.gridIntegrator?.getPositiveKwh() ?? 0) * 1000,
        gridOutWh: (inverterDevice.gridIntegrator?.getNegativeKwh() ?? 0) * 1000,
        loadWh: null  // Load is calculated at site level only
      } : null;
      
      return {
        ...device,
        energyCounters
      };
    });
    
    return {
      name: this.name,
      devices: devicesWithEnergy,
      power: {
        solarW: this.getTotalSolarPowerW(),
        batteryW: this.getTotalBatteryPowerW(),
        gridW: this.getTotalGridPowerW(),
        loadW: this.calculateLoadPowerW()
      },
      energy: this.getEnergyTotals(),
      batterySOC: this.getBatterySOC(),
      hasFault: this.hasFault(),
      faults: this.getFaults()
    };
  }
  
  public hasFault(): boolean {
    return Array.from(this.inverters.values()).some(inv => inv.faultCode !== undefined);
  }
  
  public getFaults(): Array<{serialNumber: string, faultCode: string | number, timestamp?: Date}> {
    const faults: Array<{serialNumber: string, faultCode: string | number, timestamp?: Date}> = [];
    
    for (const inverter of this.inverters.values()) {
      if (inverter.faultCode) {
        faults.push({
          serialNumber: inverter.serialNumber,
          faultCode: inverter.faultCode,
          timestamp: inverter.faultTimestamp
        });
      }
    }
    
    return faults;
  }
  
  // Historical data methods
  public getHistory(serialNumber?: string): Map<string, HistoricalDataPoint[]> | HistoricalDataPoint[] | null {
    if (serialNumber) {
      return this.historicalData.get(serialNumber) || null;
    }
    return this.historicalData;
  }
  
  public getHistoricalData(): Record<string, any[]> {
    const result: Record<string, any[]> = {};
    this.historicalData.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  
  // Energy counter methods
  public getEnergyCounters(serialNumber?: string): any {
    if (serialNumber) {
      const inverterDevice = this.inverters.get(serialNumber);
      if (!inverterDevice) return null;
      
      return {
        solarWh: (inverterDevice.solarIntegrator?.getTotalKwh() || 0) * 1000,
        batteryInWh: (inverterDevice.batteryIntegrator?.getNegativeKwh() || 0) * 1000,
        batteryOutWh: (inverterDevice.batteryIntegrator?.getPositiveKwh() || 0) * 1000,
        gridInWh: (inverterDevice.gridIntegrator?.getPositiveKwh() || 0) * 1000,
        gridOutWh: (inverterDevice.gridIntegrator?.getNegativeKwh() || 0) * 1000,
        loadWh: 0
      };
    }
    
    return this.getEnergyTotals();
  }
  
  public getFormattedEnergyCounters(serialNumber?: string): any {
    return this.getEnergyCounters(serialNumber);
  }
  
  // FroniusMinutely reporting
  public generateFroniusMinutely(): FroniusMinutely | null {
    const energyTotals = this.getEnergyTotals();
    
    // Don't generate FroniusMinutely if we have no data yet
    if (energyTotals.solarWh === null && energyTotals.gridInWh === null) {
      return null;
    }
    
    const totalCurrentWh = {
      solarWh: energyTotals.solarWh ?? 0,
      batteryInWh: energyTotals.batteryInWh ?? 0,
      batteryOutWh: energyTotals.batteryOutWh ?? 0,
      gridInWh: energyTotals.gridInWh ?? 0,
      gridOutWh: energyTotals.gridOutWh ?? 0,
      loadWh: energyTotals.loadWh ?? 0
    };
    
    const lastSnapshot = this.lastEnergySnapshot.get('total');
    
    if (!lastSnapshot) {
      this.lastEnergySnapshot.set('total', totalCurrentWh);
      this.lastEnergySnapshot.set('master', { solarWh: 0 });
      this.lastEnergySnapshot.set('slave', { solarWh: 0 });
      return null;
    }
    
    const delta = {
      solarWh: Math.round(totalCurrentWh.solarWh - (lastSnapshot.solarWh || 0)),
      batteryInWh: Math.round(totalCurrentWh.batteryInWh - (lastSnapshot.batteryInWh || 0)),
      batteryOutWh: Math.round(totalCurrentWh.batteryOutWh - (lastSnapshot.batteryOutWh || 0)),
      gridInWh: Math.round(totalCurrentWh.gridInWh - (lastSnapshot.gridInWh || 0)),
      gridOutWh: Math.round(totalCurrentWh.gridOutWh - (lastSnapshot.gridOutWh || 0)),
      loadWh: Math.round(totalCurrentWh.loadWh - (lastSnapshot.loadWh || 0))
    };
    
    const nextSnapshot = {
      solarWh: (lastSnapshot.solarWh || 0) + delta.solarWh,
      batteryInWh: (lastSnapshot.batteryInWh || 0) + delta.batteryInWh,
      batteryOutWh: (lastSnapshot.batteryOutWh || 0) + delta.batteryOutWh,
      gridInWh: (lastSnapshot.gridInWh || 0) + delta.gridInWh,
      gridOutWh: (lastSnapshot.gridOutWh || 0) + delta.gridOutWh,
      loadWh: (lastSnapshot.loadWh || 0) + delta.loadWh
    };
    
    this.lastEnergySnapshot.set('total', nextSnapshot);
    
    // Calculate master/slave solar split
    let masterPowerW = 0;
    let slavePowerW = 0;
    
    for (const inverter of this.inverters.values()) {
      if (inverter.currentPower.solarW) {
        if (inverter.isMaster) {
          masterPowerW += inverter.currentPower.solarW;
        } else {
          slavePowerW += inverter.currentPower.solarW;
        }
      }
    }
    
    const masterSnapshot = this.lastEnergySnapshot.get('master') || { solarWh: 0 };
    const slaveSnapshot = this.lastEnergySnapshot.get('slave') || { solarWh: 0 };
    
    const totalSolarPowerW = masterPowerW + slavePowerW;
    let masterSolarIntervalWh = 0;
    let slaveSolarIntervalWh = 0;
    
    if (totalSolarPowerW > 0 && delta.solarWh > 0) {
      const masterRatio = masterPowerW / totalSolarPowerW;
      masterSolarIntervalWh = Math.round(delta.solarWh * masterRatio);
      slaveSolarIntervalWh = delta.solarWh - masterSolarIntervalWh;
    }
    
    this.lastEnergySnapshot.set('master', { solarWh: masterSnapshot.solarWh + masterSolarIntervalWh });
    this.lastEnergySnapshot.set('slave', { solarWh: slaveSnapshot.solarWh + slaveSolarIntervalWh });
    
    this.sequenceNumber++;
    
    const faults = this.getFaults();
    let faultCode: string | number | null = null;
    let faultTimestamp: string | null = null;
    
    if (faults.length > 0) {
      faultCode = faults[0].faultCode;
      faultTimestamp = faults[0].timestamp ? formatLocalDateTime(faults[0].timestamp) : null;
    }
    
    const froniusMinutely: FroniusMinutely = {
      timestamp: formatLocalDateTime(new Date()),
      sequence: `${this.sessionId}/${this.sequenceNumber}`,
      solarW: Math.round(totalSolarPowerW),
      solarIntervalWh: delta.solarWh,
      
      solarLocalW: Math.round(masterPowerW),
      solarLocalIntervalWh: masterSolarIntervalWh,
      
      solarRemoteW: Math.round(slavePowerW),
      solarRemoteIntervalWh: slaveSolarIntervalWh,
      
      loadW: Math.round(this.calculateLoadPowerW() || 0),
      loadIntervalWh: delta.loadWh,
      
      batteryW: Math.round(this.getTotalBatteryPowerW() ?? 0),
      batteryInIntervalWh: delta.batteryInWh,
      batteryOutIntervalWh: delta.batteryOutWh,
      
      gridW: Math.round(this.getTotalGridPowerW() ?? 0),
      gridInIntervalWh: delta.gridInWh,
      gridOutIntervalWh: delta.gridOutWh,
      
      batterySOC: this.getBatterySOC() !== null ? Math.round(this.getBatterySOC()! * 10) / 10 : null,
      
      faultCode: faultCode,
      faultTimestamp: faultTimestamp,
      
      generatorStatus: null,
      
      solarKwhTotal: null,
      loadKwhTotal: null,
      batteryInKwhTotal: null,
      batteryOutKwhTotal: null,
      gridInKwhTotal: null,
      gridOutKwhTotal: null
    };
    
    this.froniusMinutelyHistory.unshift(froniusMinutely);
    if (this.froniusMinutelyHistory.length > 10) {
      this.froniusMinutelyHistory.pop();
    }
    
    return froniusMinutely;
  }
  
  public getFroniusMinutelyHistory(): FroniusMinutely[] {
    return [...this.froniusMinutelyHistory];
  }
  
  // Site name management
  public getName(): string {
    return this.name;
  }
  
  public setName(name: string): void {
    this.name = name;
  }
}

// Create singleton instance
let instance: Site | null = null;

export function getSite(): Site {
  if (!instance) {
    instance = new Site();
  }
  return instance;
}