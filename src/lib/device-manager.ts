import { discoverFroniusInverters } from './fronius-discovery';
import axios from 'axios';
import EventEmitter from 'events';
import { formatLocalDateTime } from './date-utils';
import { isFaultStatus } from './fronius-status-codes';
import { Site, InverterDevice } from './site';
import { EnergyIntegrator, BidirectionalEnergyIntegrator } from './energy-integrator';

interface FroniusDevice {
  ip: string;
  mac: string;
  hostname?: string;
  isMaster: boolean;
  serialNumber: string;  // Required unique identifier
  data?: any;
  info?: {
    CustomName?: string;
    DT?: number;
    StatusCode?: number;
  };
  lastUpdated?: Date;
  lastDataFetch?: Date;
}

interface HistoricalDataPoint {
  timestamp: Date;
  solar?: number;
  battery?: number;
  grid?: number;
  load?: number;
  soc?: number;
}

interface FroniusMinutely {
  timestamp: string;  // Formatted using formatLocalDateTime
  sequence: string;   // Format: "XXXX/N" where XXXX is 4-digit hex, N is incrementing decimal
  solarW: number;
  solarIntervalWh: number;
  
  solarLocalW: number;
  solarLocalIntervalWh: number;
  
  solarRemoteW: number;
  solarRemoteIntervalWh: number;
  
  loadW: number;
  loadIntervalWh: number;
  
  batteryW: number;
  batteryInIntervalWh: number;
  batteryOutIntervalWh: number;
  
  gridW: number;
  gridInIntervalWh: number;
  gridOutIntervalWh: number;
  
  batterySOC: number | null;
  
  faultCode: string | number | null;
  faultTimestamp: string | null;  // Formatted using formatLocalDateTime
  
  generatorStatus: null;  // Fronius doesn't have generator
  
  // Total accumulated values in kWh (null for now, can be added later)
  solarKwhTotal: number | null;
  loadKwhTotal: number | null;
  batteryInKwhTotal: number | null;
  batteryOutKwhTotal: number | null;
  gridInKwhTotal: number | null;
  gridOutKwhTotal: number | null;
}


class DeviceManager extends EventEmitter {
  private devices: Map<string, FroniusDevice> = new Map();  // Keyed by serial number
  private site: Site;
  private inverterDevices: Map<string, InverterDevice> = new Map();  // Keyed by serial number
  private pollingInterval: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;
  private lastScan: Date | null = null;
  private historicalData: Map<string, HistoricalDataPoint[]> = new Map();  // Keyed by serial number
  private lastEnergySnapshot: Map<string, any> = new Map();  // Stores Wh values for delta calculation
  private energyDeltaInterval: NodeJS.Timeout | null = null;
  private sessionId: string = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0').toUpperCase();
  private sequenceNumber: number = 0;

  constructor() {
    super();
    // Create the site
    this.site = new Site('Main Site');
    
    // Log server startup info
    console.log('================================================');
    console.log('Fronius Device Manager initialised');
    console.log(`Server running on port: ${process.env.PORT || 8080}`);
    console.log('================================================');
    
    // Start automatic polling
    this.startPolling();
    
    // Start energy delta reporting (once per minute)
    this.startEnergyDeltaReporting();
    
    // Schedule initial scan to run after server is fully started
    // This ensures the web server is ready immediately
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
    }, 2 * 1000); // 2 seconds
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
    // Get power values from site
    const totalSolarPowerW = this.site.getTotalSolarPowerW();
    const batteryPowerW = this.site.getTotalBatteryPowerW();
    const gridPowerW = this.site.getTotalGridPowerW();
    const loadPowerW = this.site.calculateLoadPowerW();
    const batterySOC = this.site.getBatterySOC();
    
    // Separate master/slave solar for reporting
    let masterPowerW = 0;
    let slavePowerW = 0;
    for (const inverter of this.site.getInverters()) {
      if (inverter.currentPower.solar) {
        if (inverter.isMaster) {
          masterPowerW += inverter.currentPower.solar;
        } else {
          slavePowerW += inverter.currentPower.solar;
        }
      }
    }
    
    // Get energy totals from site
    const energyTotals = this.site.getEnergyTotals();
    let totalCurrentWh = {
      solar: energyTotals.solar * 1000,
      batteryIn: energyTotals.batteryIn * 1000,
      batteryOut: energyTotals.batteryOut * 1000,
      gridIn: energyTotals.gridIn * 1000,
      gridOut: energyTotals.gridOut * 1000,
      load: energyTotals.load * 1000
    };
    
    // Check for faults
    let faultCode: string | number | null = null;
    let faultTimestamp: Date | null = null;
    const faults = this.site.getFaults();
    if (faults.length > 0) {
      faultCode = faults[0].faultCode;
      faultTimestamp = faults[0].timestamp || null;
    }
    
    const lastSnapshot = this.lastEnergySnapshot.get('total');
    
    if (lastSnapshot) {
      // Calculate deltas in Wh and round to integers
      const deltaWh = {
        solar: Math.round(totalCurrentWh.solar - lastSnapshot.solar),
        batteryIn: Math.round(totalCurrentWh.batteryIn - lastSnapshot.batteryIn),
        batteryOut: Math.round(totalCurrentWh.batteryOut - lastSnapshot.batteryOut),
        gridIn: Math.round(totalCurrentWh.gridIn - lastSnapshot.gridIn),
        gridOut: Math.round(totalCurrentWh.gridOut - lastSnapshot.gridOut),
        load: Math.round(totalCurrentWh.load - lastSnapshot.load)
      };
      
      // Advance snapshot by the rounded delta to prevent error accumulation
      const nextSnapshot = {
        solar: lastSnapshot.solar + deltaWh.solar,
        batteryIn: lastSnapshot.batteryIn + deltaWh.batteryIn,
        batteryOut: lastSnapshot.batteryOut + deltaWh.batteryOut,
        gridIn: lastSnapshot.gridIn + deltaWh.gridIn,
        gridOut: lastSnapshot.gridOut + deltaWh.gridOut,
        load: lastSnapshot.load + deltaWh.load
      };
      
      // Store the advanced snapshot for next time
      this.lastEnergySnapshot.set('total', nextSnapshot);
      
      // Calculate separate master/slave energy deltas
      const masterSnapshot = this.lastEnergySnapshot.get('master') || { solar: 0 };
      const slaveSnapshot = this.lastEnergySnapshot.get('slave') || { solar: 0 };
      
      // Approximate master/slave split based on current power ratio
      const totalSolarPowerW = masterPowerW + slavePowerW;
      let masterSolarIntervalWh = 0;
      let slaveSolarIntervalWh = 0;
      
      if (totalSolarPowerW > 0) {
        const masterRatio = masterPowerW / totalSolarPowerW;
        masterSolarIntervalWh = Math.round(deltaWh.solar * masterRatio);
        slaveSolarIntervalWh = deltaWh.solar - masterSolarIntervalWh;
      }
      
      // Update master/slave snapshots
      this.lastEnergySnapshot.set('master', { solar: masterSnapshot.solar + masterSolarIntervalWh });
      this.lastEnergySnapshot.set('slave', { solar: slaveSnapshot.solar + slaveSolarIntervalWh });
      
      // Increment sequence number
      this.sequenceNumber++;
      
      // Create FroniusMinutely object
      const froniusMinutely: FroniusMinutely = {
        timestamp: formatLocalDateTime(new Date()),
        sequence: `${this.sessionId}/${this.sequenceNumber}`,
        solarW: Math.round(totalSolarPowerW),
        solarIntervalWh: deltaWh.solar,
        
        solarLocalW: Math.round(masterPowerW),
        solarLocalIntervalWh: masterSolarIntervalWh,
        
        solarRemoteW: Math.round(slavePowerW),
        solarRemoteIntervalWh: slaveSolarIntervalWh,
        
        loadW: Math.round(loadPowerW),
        loadIntervalWh: deltaWh.load,
        
        batteryW: Math.round(batteryPowerW),
        batteryInIntervalWh: deltaWh.batteryIn,
        batteryOutIntervalWh: deltaWh.batteryOut,
        
        gridW: Math.round(gridPowerW),
        gridInIntervalWh: deltaWh.gridIn,
        gridOutIntervalWh: deltaWh.gridOut,
        
        batterySOC: batterySOC !== null ? Math.round(batterySOC * 10) / 10 : null,
        
        faultCode: faultCode,
        faultTimestamp: faultTimestamp ? formatLocalDateTime(faultTimestamp) : null,
        
        generatorStatus: null,  // Fronius doesn't have generator
        
        // Total accumulated values in kWh (null for now, can be added later)
        solarKwhTotal: null,
        loadKwhTotal: null,
        batteryInKwhTotal: null,
        batteryOutKwhTotal: null,
        gridInKwhTotal: null,
        gridOutKwhTotal: null
      };
      
      // Emit FroniusMinutely object
      this.emit('froniusMinutely', froniusMinutely);
    } else {
      // First snapshot - initialise with current values
      this.lastEnergySnapshot.set('total', totalCurrentWh);
      this.lastEnergySnapshot.set('master', { solar: 0 });
      this.lastEnergySnapshot.set('slave', { solar: 0 });
    }
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
      
      // Update device cache and Site
      for (const device of discoveredDevices) {
        const existingDevice = this.devices.get(device.serialNumber);
        const updatedDevice = {
          ...device,
          lastUpdated: new Date(),
          lastDataFetch: existingDevice?.lastDataFetch
        };
        
        this.devices.set(device.serialNumber, updatedDevice);
        
        // Create or update InverterDevice in Site
        let inverterDevice = this.inverterDevices.get(device.serialNumber);
        if (!inverterDevice) {
          inverterDevice = {
            serialNumber: device.serialNumber,
            ip: device.ip,
            hostname: device.hostname,
            isMaster: device.isMaster,
            name: device.info?.CustomName || device.hostname?.split('.')[0] || device.ip,
            solarIntegrator: new EnergyIntegrator(),
            batteryIntegrator: new BidirectionalEnergyIntegrator(), // Any inverter can have a battery
            gridIntegrator: device.isMaster ? new BidirectionalEnergyIntegrator() : null, // Only master has grid connection
            currentPower: {},
            lastData: undefined,
            lastDataFetch: undefined
          };
          this.inverterDevices.set(device.serialNumber, inverterDevice);
          this.site.addInverter(inverterDevice);
        }
      }

      // Remove devices that are no longer discovered
      const discoveredSerials = new Set(discoveredDevices.map(d => d.serialNumber));
      for (const [serialNumber, device] of this.devices.entries()) {
        if (!discoveredSerials.has(serialNumber)) {
          this.devices.delete(serialNumber);
          this.inverterDevices.delete(serialNumber);
          this.site.removeInverter(serialNumber);
        }
      }

      console.log(`Scan complete. Found ${this.devices.size} devices.`);
      
      // Emit update event
      this.emit('devicesUpdated', this.getDevices());
      
      // Emit scan complete
      this.emit('scanStatus', { 
        status: 'completed', 
        message: `Scan complete. Found ${this.devices.size} device(s)`,
        count: this.devices.size 
      });
      
      // Fetch data for all devices after scan
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
      updatePromises.push(this.updateDeviceData(device.ip));
    }
    
    await Promise.all(updatePromises);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // console.log(`${this.devices.size} devices updated in ${duration}s`);
  }

  private async updateDeviceData(ip: string): Promise<void> {
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

      // Fetch multiple endpoints in parallel for energy data
      const [powerFlowResponse, inverterResponse, meterResponse] = await Promise.allSettled([
        axios.get(`http://${ip}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`, { timeout: 5000 }),
        axios.get(`http://${ip}/solar_api/v1/GetInverterRealtimeData.cgi?Datacollection=CumulationInverterData`, { timeout: 5000 }),
        axios.get(`http://${ip}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`, { timeout: 5000 })
      ]);

      if (powerFlowResponse.status === 'fulfilled' && powerFlowResponse.value.data) {
        device.data = powerFlowResponse.value.data;
        device.lastDataFetch = new Date();
        this.devices.set(device.serialNumber, device);
        
        // Update InverterDevice data
        const inverterDevice = this.inverterDevices.get(device.serialNumber);
        if (inverterDevice) {
          inverterDevice.lastData = powerFlowResponse.value.data;
          inverterDevice.lastDataFetch = new Date();
        }
        
        // Store historical data
        if (powerFlowResponse.value.data?.Body?.Data?.Site) {
          const site = powerFlowResponse.value.data.Body.Data.Site;
          const inverters = powerFlowResponse.value.data.Body.Data.Inverters;
          const firstInverter = inverters && Object.values(inverters)[0] as any;
          
          const dataPoint: HistoricalDataPoint = {
            timestamp: new Date(),
            solar: site.P_PV ?? undefined,
            battery: site.P_Akku ?? undefined,
            grid: site.P_Grid ?? undefined,
            load: site.P_Load ?? undefined,
            soc: firstInverter?.SOC ?? undefined
          };
          
          // Get or create history array for this device (by serial number)
          const history = this.historicalData.get(device.serialNumber) || [];
          history.push(dataPoint);
          
          // Keep only last 10 minutes of data (300 samples at 2-second polling interval)
          if (history.length > 300) {
            history.shift();
          }
          
          this.historicalData.set(device.serialNumber, history);
        }
        
        // Update energy integrators
        this.updateEnergyIntegrators(ip, powerFlowResponse.value.data, 
          inverterResponse.status === 'fulfilled' ? inverterResponse.value.data : null,
          meterResponse.status === 'fulfilled' ? meterResponse.value.data : null);
        
        // Emit update for this specific device
        this.emit('deviceDataUpdated', {
          ip,
          serialNumber: deviceSerialNumber,
          data: powerFlowResponse.value.data,
          timestamp: new Date()
        });
      }
      
      // Clear fault code if everything is successful
      const inverterDevice = this.inverterDevices.get(device.serialNumber);
      if (inverterDevice) {
        delete inverterDevice.faultCode;
        delete inverterDevice.faultTimestamp;
      }
    } catch (error) {
      console.error(`Error fetching data for ${ip}:`, error);
      
      // Find device by IP to get serial number
      let serialNumber = ip;  // Fallback to IP if device not found
      for (const [sn, d] of this.devices.entries()) {
        if (d.ip === ip) {
          serialNumber = sn;
          break;
        }
      }
      
      // Track error in inverter device
      const inverterDevice = this.inverterDevices.get(serialNumber);
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
    if (!device || !serialNumber) return;  // No device found
    
    // Get the InverterDevice from site
    const inverterDevice = this.inverterDevices.get(serialNumber);
    if (!inverterDevice) return;
    
    const now = new Date();
    
    // Set initial hardware counter values if available
    if (inverterData?.Body?.Data?.TOTAL_ENERGY?.Values?.['1'] !== undefined && inverterDevice.solarIntegrator) {
      inverterDevice.solarIntegrator.setInitialHardwareCounter(inverterData.Body.Data.TOTAL_ENERGY.Values['1']);
      inverterDevice.solarIntegrator.updateHardwareCounter(inverterData.Body.Data.TOTAL_ENERGY.Values['1']);
    }
    
    if (meterData?.Body?.Data?.['0'] && inverterDevice.gridIntegrator) {
      const meter = meterData.Body.Data['0'];
      // Grid integrators track consumed/produced separately in hardware
      // We'll track them as part of the bidirectional integrator
    }
    
    // Update integrators with current power values
    if (powerFlowData?.Body?.Data?.Site) {
      const site = powerFlowData.Body.Data.Site;
      const inverters = powerFlowData.Body.Data.Inverters;
      const firstInverter = inverters && Object.values(inverters)[0] as any;
      
      // Update current power values
      inverterDevice.currentPower = {
        solar: site.P_PV ?? undefined,
        battery: site.P_Akku ?? undefined,
        grid: site.P_Grid ?? undefined,
        load: site.P_Load ?? undefined,
        soc: firstInverter?.SOC ?? undefined
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

  public getDevices(): FroniusDevice[] {
    return Array.from(this.devices.values());
  }

  public getDevice(serialNumber: string): FroniusDevice | undefined {
    return this.devices.get(serialNumber);
  }

  public async fetchDeviceData(ip: string): Promise<any> {
    await this.updateDeviceData(ip);
    // Find device by IP
    for (const [serialNumber, device] of this.devices.entries()) {
      if (device.ip === ip) {
        return device.data;
      }
    }
    return undefined;
  }

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
    return {
      name: this.site.getName(),
      powerW: {
        solar: this.site.getTotalSolarPowerW(),
        battery: this.site.getTotalBatteryPowerW(),
        grid: this.site.getTotalGridPowerW(),
        load: this.site.calculateLoadPowerW()
      },
      energyKwh: this.site.getEnergyTotals(),
      batterySOC: this.site.getBatterySOC(),
      hasFault: this.site.hasFault(),
      faults: this.site.getFaults()
    };
  }

  public getHistory(serialNumber?: string): Map<string, HistoricalDataPoint[]> | HistoricalDataPoint[] | null {
    if (serialNumber) {
      return this.historicalData.get(serialNumber) || null;
    }
    return this.historicalData;
  }

  public getEnergyCounters(serialNumber?: string): any {
    // Returns energy data for a specific inverter or all
    if (serialNumber) {
      const inverterDevice = this.inverterDevices.get(serialNumber);
      if (!inverterDevice) return null;
      
      return {
        solar: inverterDevice.solarIntegrator?.getTotalKwh() || 0,
        batteryIn: inverterDevice.batteryIntegrator?.getNegativeKwh() || 0,
        batteryOut: inverterDevice.batteryIntegrator?.getPositiveKwh() || 0,
        gridIn: inverterDevice.gridIntegrator?.getPositiveKwh() || 0,
        gridOut: inverterDevice.gridIntegrator?.getNegativeKwh() || 0,
        load: 0  // Load is calculated at site level only
      };
    }
    
    // Return site totals
    return this.site.getEnergyTotals();
  }

  public getFormattedEnergyCounters(serialNumber?: string): any {
    if (serialNumber) {
      // Get individual inverter counters
      const inverterDevice = this.inverterDevices.get(serialNumber);
      if (!inverterDevice) return null;
      
      return {
        solar: inverterDevice.solarIntegrator?.getTotalKwh() || 0,
        batteryIn: inverterDevice.batteryIntegrator?.getNegativeKwh() || 0,
        batteryOut: inverterDevice.batteryIntegrator?.getPositiveKwh() || 0,
        gridIn: inverterDevice.gridIntegrator?.getPositiveKwh() || 0,
        gridOut: inverterDevice.gridIntegrator?.getNegativeKwh() || 0,
        load: 0  // Load is calculated at site level only
      };
    }
    
    // Return site totals
    return this.site.getEnergyTotals();
  }
}

// Create singleton instance
let instance: DeviceManager | null = null;

export function getDeviceManager(): DeviceManager {
  if (!instance) {
    instance = new DeviceManager();
  }
  return instance;
}