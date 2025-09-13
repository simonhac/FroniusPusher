import { discoverFroniusInverters } from './fronius-discovery';
import axios from 'axios';
import EventEmitter from 'events';

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

interface EnergyCounters {
  // Initial values from API (absolute counters)
  solarTotalInitial?: number;      // From inverter TOTAL_ENERGY
  gridConsumedInitial?: number;    // From meter EnergyReal_WAC_Sum_Consumed
  gridProducedInitial?: number;    // From meter EnergyReal_WAC_Sum_Produced
  
  // Current values from API
  solarTotalCurrent?: number;
  gridConsumedCurrent?: number;
  gridProducedCurrent?: number;
  
  // Integrated values from power readings
  solarIntegrated: number;         // Integrated from P_PV
  gridImportIntegrated: number;    // Integrated from P_Grid when positive
  gridExportIntegrated: number;    // Integrated from P_Grid when negative
  batteryCharged: number;          // Accumulated when P_Akku < 0
  batteryDischarged: number;       // Accumulated when P_Akku > 0
  
  // Last power values for accumulation
  lastSolarPower?: number;
  lastGridPower?: number;
  lastBatteryPower?: number;
  lastUpdateTime?: Date;
  
  // Fault tracking
  faultCode?: string | number;
  faultTimestamp?: Date;
}

class DeviceManager extends EventEmitter {
  private devices: Map<string, FroniusDevice> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;
  private lastScan: Date | null = null;
  private historicalData: Map<string, HistoricalDataPoint[]> = new Map();
  private energyCounters: Map<string, EnergyCounters> = new Map();
  private lastEnergySnapshot: Map<string, any> = new Map();  // Stores Wh values for delta calculation
  private energyDeltaInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    // Log server startup info
    console.log('================================================');
    console.log('Fronius Device Manager initialized');
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
        this.reportEnergyDeltas();
        
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

  private reportEnergyDeltas() {
    // Aggregate totals across all devices
    let masterPowerW = 0;
    let slavePowerW = 0;
    let batteryPowerW = 0;
    let gridPowerW = 0;
    let loadPowerW = 0;
    let batterySOC: number | null = null;
    let faultCode: string | number | null = null;
    let faultTimestamp: Date | null = null;
    
    let totalCurrentWh = {
      solar: 0,
      batteryIn: 0,
      batteryOut: 0,
      gridIn: 0,
      gridOut: 0,
      load: 0
    };
    
    // Collect current values from all devices
    for (const [ip, device] of this.devices.entries()) {
      const currentCounters = this.getFormattedEnergyCounters(ip);
      const energyCounter = this.energyCounters.get(ip);
      
      if (currentCounters) {
        // Convert current values from kWh to Wh and add to totals
        totalCurrentWh.solar += currentCounters.solar * 1000;
        totalCurrentWh.batteryIn += currentCounters.batteryIn * 1000;
        totalCurrentWh.batteryOut += currentCounters.batteryOut * 1000;
        totalCurrentWh.gridIn += currentCounters.gridIn * 1000;
        totalCurrentWh.gridOut += currentCounters.gridOut * 1000;
        totalCurrentWh.load += currentCounters.load * 1000;
      }
      
      // Collect current power values and separate master/slave solar
      if (device.data?.Body?.Data?.Site) {
        const site = device.data.Body.Data.Site;
        
        // Solar power - separate master from slaves
        if (site.P_PV !== undefined && site.P_PV !== null) {
          if (device.isMaster) {
            masterPowerW += site.P_PV;
          } else {
            slavePowerW += site.P_PV;
          }
        }
        
        // Battery power (only master reports this)
        if (device.isMaster && site.P_Akku !== undefined && site.P_Akku !== null) {
          batteryPowerW = site.P_Akku;
        }
        
        // Grid power (only master reports this)
        if (device.isMaster && site.P_Grid !== undefined && site.P_Grid !== null) {
          gridPowerW = site.P_Grid;
        }
        
        // Load power (only master reports this)
        if (device.isMaster && site.P_Load !== undefined && site.P_Load !== null) {
          loadPowerW = Math.abs(site.P_Load);
        }
        
        // Battery SOC (from first inverter)
        if (batterySOC === null && device.data.Body.Data.Inverters) {
          const firstInverter = Object.values(device.data.Body.Data.Inverters)[0] as any;
          if (firstInverter?.SOC !== undefined && firstInverter?.SOC !== null) {
            batterySOC = firstInverter.SOC;
          }
        }
      }
      
      // Check for fault codes
      if (energyCounter?.faultCode) {
        faultCode = energyCounter.faultCode;
        faultTimestamp = energyCounter.faultTimestamp || null;
      }
      
      // Check inverter status code
      if (device.info?.StatusCode && device.info.StatusCode !== 7) {
        // StatusCode 7 is normal operation
        faultCode = `INVERTER_STATUS_${device.info.StatusCode}`;
        faultTimestamp = new Date();
      }
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
      
      // Emit energy deltas in the new format
      this.emit('energyDeltas', {
        timestamp: new Date(),
        solarW: masterPowerW + slavePowerW,
        solarIntervalWh: deltaWh.solar,
        
        solarLocalW: masterPowerW,
        solarLocalIntervalWh: masterSolarIntervalWh,
        
        solarRemoteW: slavePowerW,
        solarRemoteIntervalWh: slaveSolarIntervalWh,
        
        loadW: loadPowerW,
        loadIntervalWh: deltaWh.load,
        
        batteryW: batteryPowerW,
        batteryInIntervalWh: deltaWh.batteryIn,
        batteryOutIntervalWh: deltaWh.batteryOut,
        
        gridW: gridPowerW,
        gridInIntervalWh: deltaWh.gridIn,
        gridOutIntervalWh: deltaWh.gridOut,
        
        batterySOC: batterySOC,
        
        faultCode: faultCode,
        faultTimestamp: faultTimestamp,
        
        generatorStatus: null,  // Fronius doesn't have generator
        
        // Total accumulated values in kWh (null for now, can be added later)
        solarKwhTotal: null,
        loadKwhTotal: null,
        batteryInKwhTotal: null,
        batteryOutKwhTotal: null,
        gridInKwhTotal: null,
        gridOutKwhTotal: null
      });
    } else {
      // First snapshot - initialize with current values
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
      
      // Update device cache
      for (const device of discoveredDevices) {
        const existingDevice = this.devices.get(device.ip);
        const updatedDevice = {
          ...device,
          lastUpdated: new Date(),
          lastDataFetch: existingDevice?.lastDataFetch
        };
        
        this.devices.set(device.ip, updatedDevice);
      }

      // Remove devices that are no longer discovered
      const discoveredIPs = new Set(discoveredDevices.map(d => d.ip));
      for (const [ip, device] of this.devices.entries()) {
        if (!discoveredIPs.has(ip)) {
          this.devices.delete(ip);
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
    
    for (const [ip, device] of this.devices.entries()) {
      updatePromises.push(this.updateDeviceData(ip));
    }
    
    await Promise.all(updatePromises);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // console.log(`${this.devices.size} devices updated in ${duration}s`);
  }

  private async updateDeviceData(ip: string): Promise<void> {
    try {
      const device = this.devices.get(ip);
      if (!device) return;

      // Fetch multiple endpoints in parallel for energy data
      const [powerFlowResponse, inverterResponse, meterResponse] = await Promise.allSettled([
        axios.get(`http://${ip}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`, { timeout: 5000 }),
        axios.get(`http://${ip}/solar_api/v1/GetInverterRealtimeData.cgi?Datacollection=CumulationInverterData`, { timeout: 5000 }),
        axios.get(`http://${ip}/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`, { timeout: 5000 })
      ]);

      if (powerFlowResponse.status === 'fulfilled' && powerFlowResponse.value.data) {
        device.data = powerFlowResponse.value.data;
        device.lastDataFetch = new Date();
        this.devices.set(ip, device);
        
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
          
          // Get or create history array for this device
          const history = this.historicalData.get(ip) || [];
          history.push(dataPoint);
          
          // Keep only last 10 minutes of data (300 samples at 2-second polling interval)
          if (history.length > 300) {
            history.shift();
          }
          
          this.historicalData.set(ip, history);
        }
        
        // Update energy counters
        this.updateEnergyCounters(ip, powerFlowResponse.value.data, 
          inverterResponse.status === 'fulfilled' ? inverterResponse.value.data : null,
          meterResponse.status === 'fulfilled' ? meterResponse.value.data : null);
        
        // Emit update for this specific device
        this.emit('deviceDataUpdated', {
          ip,
          data: powerFlowResponse.value.data,
          timestamp: new Date()
        });
      }
      
      // Clear fault code if everything is successful
      const existingCounters = this.energyCounters.get(ip);
      if (existingCounters) {
        delete existingCounters.faultCode;
        delete existingCounters.faultTimestamp;
        this.energyCounters.set(ip, existingCounters);
      }
    } catch (error) {
      console.error(`Error fetching data for ${ip}:`, error);
      
      // Track error in energy counters
      const counters = this.energyCounters.get(ip) || {
        solarIntegrated: 0,
        gridImportIntegrated: 0,
        gridExportIntegrated: 0,
        batteryCharged: 0,
        batteryDischarged: 0
      };
      
      // Set fault code based on error type
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          counters.faultCode = 'TIMEOUT';
        } else if (error.response) {
          counters.faultCode = `HTTP_${error.response.status}`;
        } else if (error.code === 'ECONNREFUSED') {
          counters.faultCode = 'CONNECTION_REFUSED';
        } else if (error.code === 'EHOSTUNREACH') {
          counters.faultCode = 'HOST_UNREACHABLE';
        } else {
          counters.faultCode = error.code || 'NETWORK_ERROR';
        }
      } else {
        counters.faultCode = 'UNKNOWN_ERROR';
      }
      
      counters.faultTimestamp = new Date();
      this.energyCounters.set(ip, counters);
    }
  }

  private updateEnergyCounters(ip: string, powerFlowData: any, inverterData: any, meterData: any): void {
    let counters = this.energyCounters.get(ip);
    const now = new Date();
    const device = this.devices.get(ip);
    
    // Initialize counters if not exist
    if (!counters) {
      counters = {
        solarIntegrated: 0,
        gridImportIntegrated: 0,
        gridExportIntegrated: 0,
        batteryCharged: 0,
        batteryDischarged: 0
      };
      
      // Set initial values from API if available (only on first call)
      if (inverterData?.Body?.Data?.TOTAL_ENERGY?.Values?.['1'] !== undefined) {
        counters.solarTotalInitial = inverterData.Body.Data.TOTAL_ENERGY.Values['1'];
        counters.solarTotalCurrent = inverterData.Body.Data.TOTAL_ENERGY.Values['1'];
        const hostname = device?.hostname ? device.hostname.split('.')[0] : ip;
        const identifier = device ? `${hostname}/${device.serialNumber}` : ip;
        const formattedValue = Math.round(counters.solarTotalInitial!).toLocaleString();
        console.log(`[${identifier}] Initialized solar counter: ${formattedValue} Wh`);
      }
      
      if (meterData?.Body?.Data?.['0']) {
        const meter = meterData.Body.Data['0'];
        if (meter.EnergyReal_WAC_Sum_Consumed !== undefined) {
          counters.gridConsumedInitial = meter.EnergyReal_WAC_Sum_Consumed;
          counters.gridConsumedCurrent = meter.EnergyReal_WAC_Sum_Consumed;
        }
        if (meter.EnergyReal_WAC_Sum_Produced !== undefined) {
          counters.gridProducedInitial = meter.EnergyReal_WAC_Sum_Produced;
          counters.gridProducedCurrent = meter.EnergyReal_WAC_Sum_Produced;
        }
      }
      
      this.energyCounters.set(ip, counters);
    } else {
      // Check for hardware counter changes and compare with integrated values
      if (inverterData?.Body?.Data?.TOTAL_ENERGY?.Values?.['1'] !== undefined) {
        const newValue = inverterData.Body.Data.TOTAL_ENERGY.Values['1'];
        if (newValue !== counters.solarTotalCurrent) {
          const hardwareDelta = newValue - (counters.solarTotalCurrent || 0);
          const integratedTotal = counters.solarIntegrated; // Keep in Wh
          const hardwareTotal = newValue - (counters.solarTotalInitial || 0); // Keep in Wh
          const difference = integratedTotal - hardwareTotal;
          const diffPercent = hardwareTotal !== 0 ? (difference / hardwareTotal * 100) : 0;
          const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
          const hostname = device?.hostname ? device.hostname.split('.')[0] : ip;
          const identifier = device ? `${hostname}/${device.serialNumber}` : ip;
          console.log(`[${timestamp}] [${identifier}] Solar HW update: +${hardwareDelta} Wh | HW total: ${hardwareTotal.toFixed(0)} Wh | Integrated: ${integratedTotal.toFixed(0)} Wh | Diff: ${difference.toFixed(0)} Wh (${diffPercent.toFixed(1)}%)`);
          counters.solarTotalCurrent = newValue;
        }
      }
      
      if (meterData?.Body?.Data?.['0']) {
        const meter = meterData.Body.Data['0'];
        
        if (meter.EnergyReal_WAC_Sum_Consumed !== undefined) {
          const newValue = meter.EnergyReal_WAC_Sum_Consumed;
          if (newValue !== counters.gridConsumedCurrent) {
            const hardwareDelta = newValue - (counters.gridConsumedCurrent || 0);
            const integratedTotal = counters.gridImportIntegrated; // Keep in Wh
            const hardwareTotal = newValue - (counters.gridConsumedInitial || 0); // Keep in Wh
            const difference = integratedTotal - hardwareTotal;
            const diffPercent = hardwareTotal !== 0 ? (difference / hardwareTotal * 100) : 0;
            const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
            const hostname = device?.hostname ? device.hostname.split('.')[0] : ip;
            const identifier = device ? `${hostname}/${device.serialNumber}` : ip;
            console.log(`[${timestamp}] [${identifier}] Grid Import HW update: +${hardwareDelta} Wh | HW total: ${hardwareTotal.toFixed(0)} Wh | Integrated: ${integratedTotal.toFixed(0)} Wh | Diff: ${difference.toFixed(0)} Wh (${diffPercent.toFixed(1)}%)`);
            counters.gridConsumedCurrent = newValue;
          }
        }
        
        if (meter.EnergyReal_WAC_Sum_Produced !== undefined) {
          const newValue = meter.EnergyReal_WAC_Sum_Produced;
          if (newValue !== counters.gridProducedCurrent) {
            const hardwareDelta = newValue - (counters.gridProducedCurrent || 0);
            const integratedTotal = counters.gridExportIntegrated; // Keep in Wh
            const hardwareTotal = newValue - (counters.gridProducedInitial || 0); // Keep in Wh
            const difference = integratedTotal - hardwareTotal;
            const diffPercent = hardwareTotal !== 0 ? (difference / hardwareTotal * 100) : 0;
            const timestamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
            const hostname = device?.hostname ? device.hostname.split('.')[0] : ip;
            const identifier = device ? `${hostname}/${device.serialNumber}` : ip;
            console.log(`[${timestamp}] [${identifier}] Grid Export HW update: +${hardwareDelta} Wh | HW total: ${hardwareTotal.toFixed(0)} Wh | Integrated: ${integratedTotal.toFixed(0)} Wh | Diff: ${difference.toFixed(0)} Wh (${diffPercent.toFixed(1)}%)`);
            counters.gridProducedCurrent = newValue;
          }
        }
      }
    }
    
    // Accumulate energy based on power readings using trapezoidal integration
    if (powerFlowData?.Body?.Data?.Site && counters.lastUpdateTime) {
      const site = powerFlowData.Body.Data.Site;
      const timeDeltaHours = (now.getTime() - counters.lastUpdateTime.getTime()) / (1000 * 60 * 60);
      
      // Solar accumulation (P_PV is always positive or null)
      if (site.P_PV !== undefined && site.P_PV !== null) {
        const solarPower = site.P_PV;
        if (counters.lastSolarPower !== undefined) {
          const avgPower = (solarPower + counters.lastSolarPower) / 2;
          counters.solarIntegrated += avgPower * timeDeltaHours;
        }
        counters.lastSolarPower = solarPower;
      }
      
      // Grid accumulation (P_Grid: positive = import, negative = export)
      if (site.P_Grid !== undefined && site.P_Grid !== null) {
        const gridPower = site.P_Grid;
        if (counters.lastGridPower !== undefined) {
          const avgPower = (gridPower + counters.lastGridPower) / 2;
          if (avgPower > 0) {
            // Importing from grid
            counters.gridImportIntegrated += avgPower * timeDeltaHours;
          } else if (avgPower < 0) {
            // Exporting to grid
            counters.gridExportIntegrated += Math.abs(avgPower) * timeDeltaHours;
          }
        }
        counters.lastGridPower = gridPower;
      }
      
      // Battery accumulation (P_Akku: positive = discharge, negative = charge)
      if (site.P_Akku !== undefined && site.P_Akku !== null) {
        const batteryPower = site.P_Akku;
        if (counters.lastBatteryPower !== undefined) {
          const avgPower = (batteryPower + counters.lastBatteryPower) / 2;
          if (avgPower < 0) {
            // Charging (negative power)
            counters.batteryCharged += Math.abs(avgPower) * timeDeltaHours;
          } else if (avgPower > 0) {
            // Discharging (positive power)
            counters.batteryDischarged += avgPower * timeDeltaHours;
          }
        }
        counters.lastBatteryPower = batteryPower;
      }
    }
    
    counters.lastUpdateTime = now;
    this.energyCounters.set(ip, counters);
  }

  public getDevices(): FroniusDevice[] {
    return Array.from(this.devices.values());
  }

  public getDevice(ip: string): FroniusDevice | undefined {
    return this.devices.get(ip);
  }

  public async fetchDeviceData(ip: string): Promise<any> {
    await this.updateDeviceData(ip);
    return this.devices.get(ip)?.data;
  }

  public getStatus() {
    return {
      deviceCount: this.devices.size,
      lastScan: this.lastScan,
      isScanning: this.isScanning,
      devices: this.getDevices()
    };
  }

  public getHistory(ip?: string): Map<string, HistoricalDataPoint[]> | HistoricalDataPoint[] | null {
    if (ip) {
      return this.historicalData.get(ip) || null;
    }
    return this.historicalData;
  }

  public getEnergyCounters(ip?: string): Map<string, EnergyCounters> | EnergyCounters | null {
    if (ip) {
      return this.energyCounters.get(ip) || null;
    }
    return this.energyCounters;
  }

  public getFormattedEnergyCounters(ip: string): any {
    const counters = this.energyCounters.get(ip);
    if (!counters) return null;
    
    // Use integrated values for all energy reporting
    const solarGenerated = counters.solarIntegrated / 1000; // Convert Wh to kWh
    const gridConsumed = counters.gridImportIntegrated / 1000;
    const gridProduced = counters.gridExportIntegrated / 1000;
    
    // Calculate load using energy balance: Load = Solar + GridIn + BatteryOut - GridOut - BatteryIn
    const loadCalculated = solarGenerated + gridConsumed + (counters.batteryDischarged / 1000) 
                          - gridProduced - (counters.batteryCharged / 1000);
    
    return {
      solar: solarGenerated,
      batteryIn: counters.batteryCharged / 1000,  // Convert Wh to kWh
      batteryOut: counters.batteryDischarged / 1000,
      gridIn: gridConsumed,
      gridOut: gridProduced,
      load: loadCalculated >= 0 ? loadCalculated : 0  // Use calculated value, ensure non-negative
    };
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