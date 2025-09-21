import { discoverFroniusInverters } from './fronius-discovery';
import EventEmitter from 'events';
import { Inverter, PowerData } from './inverter';
import { InverterInfo, BatteryInfo, MeterInfo } from '@/types/device';
import { FroniusMinutely } from '@/types/fronius';
import { formatLocalDateTime } from './date-utils';

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
  battery?: BatteryInfo;
  inverterInfo?: InverterInfo;
  meter?: MeterInfo;
  lastUpdated?: Date;
  lastDataFetch?: Date;
}

export class Site extends EventEmitter {
  private name: string;
  private inverters: Map<string, Inverter> = new Map();
  private devices: Map<string, FroniusDevice> = new Map();  // Cache for discovered devices
  
  // Energy tracking
  private sessionId: string = Date.now().toString();
  private sequenceNumber: number = 0;
  private lastEnergySnapshot: Map<string, any> = new Map();
  private froniusMinutelyHistory: FroniusMinutely[] = [];
  private siteMetricsHistory: any[] = [];  // Store last 10 minutes of siteMetrics
  private lastSiteMetrics: any = null;
  
  // Polling and scanning state
  private pollingInterval: NodeJS.Timeout | null = null;
  private energyDeltaInterval: NodeJS.Timeout | null = null;
  private isScanning: boolean = false;
  private lastScan: Date | null = null;
  
  constructor(name: string = 'Main Site') {
    super();
    this.name = name;
  }
  
  // Start polling inverters
  public startPolling(intervalMs: number = 2000): void {
    if (this.pollingInterval) {
      return;
    }
    
    this.pollingInterval = setInterval(async () => {
      await this.pollAllInverters();
    }, intervalMs);
    
    // Start energy delta reporting (once per minute)
    if (!this.energyDeltaInterval) {
      this.energyDeltaInterval = setInterval(() => {
        this.generateAndEmitFroniusMinutely();
      }, 60000);
    }
    
    // Do initial poll
    this.pollAllInverters();
  }
  
  // Stop polling
  public stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    if (this.energyDeltaInterval) {
      clearInterval(this.energyDeltaInterval);
      this.energyDeltaInterval = null;
    }
  }
  
  // Poll all inverters
  private async pollAllInverters(): Promise<void> {
    const promises = Array.from(this.inverters.values()).map(inverter => 
      this.pollInverter(inverter)
    );
    
    await Promise.allSettled(promises);
    
    // Build site metrics event with site and device data
    const siteMetrics: any = {
      timestamp: formatLocalDateTime(new Date())
    };
    
    // Aggregate site-level data - use null if no devices report data
    let siteSolarW: number | null = null;
    let siteSolarWh: number | null = null;
    let siteBatteryW: number | null = null;
    let siteBatteryInWh: number | null = null;
    let siteBatteryOutWh: number | null = null;
    let siteGridW: number | null = null;
    let siteGridInWh: number | null = null;
    let siteGridOutWh: number | null = null;
    let siteLoadW: number | null = null;
    let siteLoadWh: number | null = null;
    let batterySoCs: number[] = [];
    
    // Track whether we have any data
    let hasSolarData = false;
    let hasBatteryData = false;
    let hasGridData = false;
    
    // Collect data from each inverter
    this.inverters.forEach((inverter, serialNumber) => {
      const powerData = inverter.getLastPowerData();
      const energyData = inverter.getEnergyData();
      
      if (powerData) {
        const deviceData: any = {};
        
        // Solar data
        if (powerData.solarW !== undefined) {
          deviceData.solar = {
            powerW: powerData.solarW,
            energyWh: Math.round(energyData.solarWh)
          };
          if (!hasSolarData) {
            siteSolarW = 0;
            siteSolarWh = 0;
            hasSolarData = true;
          }
          siteSolarW! += powerData.solarW;
          siteSolarWh! += energyData.solarWh;
        }
        
        // Battery data
        if (powerData.batteryW !== undefined) {
          deviceData.battery = {
            powerW: powerData.batteryW,
            energyInWh: Math.round(energyData.batteryInWh),
            energyOutWh: Math.round(energyData.batteryOutWh),
            soc: powerData.batterySoC
          };
          if (!hasBatteryData) {
            siteBatteryW = 0;
            siteBatteryInWh = 0;
            siteBatteryOutWh = 0;
            hasBatteryData = true;
          }
          siteBatteryW! += powerData.batteryW;
          siteBatteryInWh! += energyData.batteryInWh;
          siteBatteryOutWh! += energyData.batteryOutWh;
          if (powerData.batterySoC !== undefined) {
            batterySoCs.push(powerData.batterySoC);
          }
        }
        
        // Grid data (only from master)
        if (inverter.getIsMaster() && powerData.gridW !== undefined) {
          siteGridW = powerData.gridW;
          siteGridInWh = energyData.gridInWh;
          siteGridOutWh = energyData.gridOutWh;
          hasGridData = true;
        }
        
        // Add device data if it has any measurements
        if (Object.keys(deviceData).length > 0) {
          siteMetrics[serialNumber] = deviceData;
        }
      }
    });
    
    // Calculate load only if we have the necessary data
    if (hasSolarData || hasGridData || hasBatteryData) {
      siteLoadW = Math.max(0, 
        (siteSolarW || 0) + 
        (siteGridW || 0) + 
        (siteBatteryW || 0)
      );
    }
    // Calculate load energy from the energy balance equation
    if (hasSolarData || hasGridData || hasBatteryData) {
      // Load = Solar + GridIn + BatteryOut - GridOut - BatteryIn
      siteLoadWh = (siteSolarWh || 0) + (siteGridInWh || 0) + (siteBatteryOutWh || 0) - (siteGridOutWh || 0) - (siteBatteryInWh || 0);
      siteLoadWh = Math.max(0, siteLoadWh);
      // Only set to null if we truly have no data
      if (siteLoadWh === 0 && !hasSolarData && !hasGridData && !hasBatteryData) {
        siteLoadWh = null;
      }
    }
    
    // Add site-level data
    siteMetrics.site = {
      solar: {
        powerW: siteSolarW,
        energyWh: siteSolarWh !== null ? Math.round(siteSolarWh) : null
      },
      battery: {
        powerW: siteBatteryW,
        energyInWh: siteBatteryInWh !== null ? Math.round(siteBatteryInWh) : null,
        energyOutWh: siteBatteryOutWh !== null ? Math.round(siteBatteryOutWh) : null,
        soc: batterySoCs.length > 0 ? batterySoCs.reduce((a, b) => a + b, 0) / batterySoCs.length : null
      },
      grid: {
        powerW: siteGridW,
        energyInWh: siteGridInWh !== null ? Math.round(siteGridInWh) : null,
        energyOutWh: siteGridOutWh !== null ? Math.round(siteGridOutWh) : null
      },
      load: {
        powerW: siteLoadW,
        energyWh: siteLoadWh !== null ? Math.round(siteLoadWh) : null
      }
    };
    
    // Store and emit the site metrics
    this.lastSiteMetrics = siteMetrics;
    
    // Add to history and keep only last 10 minutes
    this.siteMetricsHistory.push(siteMetrics);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    this.siteMetricsHistory = this.siteMetricsHistory.filter(
      metrics => new Date(metrics.timestamp) >= tenMinutesAgo
    );
    
    this.emit('siteMetrics', siteMetrics);
  }
  
  // Poll a single inverter
  private async pollInverter(inverter: Inverter): Promise<void> {
    const powerData = await inverter.fetchPowerFlow();
    const serialNumber = inverter.getSerialNumber();
    
    // Emit heartbeat event for this inverter
    this.emit('inverterHeartbeat', {
      serialNumber,
      status: powerData ? 'online' : 'offline',
      timestamp: new Date()
    });
  }
  
  // Discover and add inverters
  public async scanForDevices(): Promise<void> {
    if (this.isScanning) {
      console.log('Scan already in progress');
      return;
    }
    
    this.isScanning = true;
    this.lastScan = new Date();
    
    // Emit initial scan status
    this.emit('scanStatus', { 
      state: 'SCANNING'
    });
    
    // Emit scan status every second while scanning
    const scanStatusInterval = setInterval(() => {
      if (this.isScanning) {
        this.emit('scanStatus', { 
          state: 'SCANNING'
        });
      }
    }, 1000);
    
    try {
      console.log('Starting device discovery...');
      const devices = await discoverFroniusInverters();
      
      if (devices.length === 0) {
        console.log('No Fronius devices found');
      } else {
        console.log(`Found ${devices.length} Fronius device(s)`);
        
        // Clear existing inverters
        this.inverters.clear();
        this.devices.clear();
        
        // Process each discovered device
        for (const device of devices) {
          console.log(`Fetching detailed info for ${device.ip}...`);
          
          // Fetch detailed information during discovery only
          const [batteryInfo, inverterInfo, meterInfo] = await Promise.all([
            Inverter.fetchBatteryInfo(device.ip),
            Inverter.fetchInverterInfo(device.ip),
            Inverter.fetchMeterInfo(device.ip)
          ]);
          
          // Update device with fetched info
          const updatedDevice = {
            ...device,
            battery: batteryInfo,
            inverterInfo: inverterInfo,
            meter: meterInfo
          };
          
          // Store device in cache
          this.devices.set(device.serialNumber, updatedDevice);
          
          // Create InverterInfo with fetched data or defaults
          const inverterInfoForConstructor: InverterInfo = inverterInfo ? {
            ...inverterInfo,
            // Use the customName from discovery if the fetched one is empty
            customName: inverterInfo.customName || device.info?.CustomName || device.hostname?.split('.')[0] || ''
          } : {
            manufacturer: 'Fronius',
            model: 'Unknown',
            pvPowerW: 0,
            customName: device.info?.CustomName || device.hostname?.split('.')[0] || '',
            serialNumber: device.serialNumber
          };
          
          // Create new Inverter instance
          const inverter = new Inverter(
            device.ip,
            device.serialNumber,
            device.isMaster,
            inverterInfoForConstructor,
            device.hostname,
            batteryInfo,
            meterInfo
          );
          
          this.inverters.set(device.serialNumber, inverter);
          
          console.log(`Added inverter: ${inverter.getDisplayName()} (${device.serialNumber})`);
          if (batteryInfo) {
            console.log(`  - Battery: ${batteryInfo.manufacturer} ${batteryInfo.model}, Capacity: ${(batteryInfo.capacityWh || 0) / 1000}kWh`);
          }
          if (inverterInfo) {
            console.log(`  - Inverter: ${inverterInfo.model}, PV: ${(inverterInfo.pvPowerW || 0) / 1000}kW`);
          }
          if (meterInfo) {
            console.log(`  - Meter: ${meterInfo.manufacturer} ${meterInfo.model} at ${meterInfo.location}`);
          }
        }
      }
    } catch (error) {
      console.error('Device discovery failed:', error);
    } finally {
      this.isScanning = false;
      
      // Stop the scan status interval
      if (scanStatusInterval) {
        clearInterval(scanStatusInterval);
      }
      
      // Emit final scan status
      this.emit('scanStatus', { 
        state: 'IDLE'
      });
      
      // Emit site update after scan completes
      this.emit('siteUpdate', this.getSiteData());
    }
  }
  
  // Calculate total solar power
  public getTotalSolarPowerW(): number | null {
    if (this.inverters.size === 0) return null;
    
    let total = 0;
    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData?.solarW !== undefined) {
        total += powerData.solarW;
      }
    }
    return total;
  }
  
  // Calculate total battery power
  public getTotalBatteryPowerW(): number | null {
    if (this.inverters.size === 0) return null;
    
    let total = 0;
    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData?.batteryW !== undefined) {
        total += powerData.batteryW;
      }
    }
    return total;
  }
  
  // Calculate total grid power (from master only)
  public getTotalGridPowerW(): number | null {
    for (const inverter of this.inverters.values()) {
      if (inverter.getIsMaster()) {
        const powerData = inverter.getLastPowerData();
        return powerData?.gridW ?? null;
      }
    }
    return null;
  }
  
  // Calculate load power from energy balance
  public calculateLoadPowerW(): number | null {
    if (this.inverters.size === 0) {
      return null;
    }
    
    let totalSolar = 0;
    let totalBatteryPower = 0;
    let totalGridPower = 0;
    let hasData = false;
    
    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData) {
        if (powerData.solarW !== undefined) {
          totalSolar += powerData.solarW;
          hasData = true;
        }
        
        if (powerData.batteryW !== undefined) {
          totalBatteryPower += powerData.batteryW;
          hasData = true;
        }
        
        if (inverter.getIsMaster() && powerData.gridW !== undefined) {
          totalGridPower = powerData.gridW;
          hasData = true;
        }
      }
    }
    
    if (!hasData) {
      return null;
    }
    
    // Load = Solar + Grid (positive = import) + Battery (positive = discharge)
    const load = totalSolar + totalGridPower + totalBatteryPower;
    return Math.max(0, Math.round(load));
  }
  
  // Get battery SOC
  public getBatterySOC(): number | null {
    const socValues: number[] = [];
    
    for (const inverter of this.inverters.values()) {
      const powerData = inverter.getLastPowerData();
      if (powerData?.batterySoC !== undefined) {
        socValues.push(powerData.batterySoC);
      }
    }
    
    if (socValues.length === 0) return null;
    
    // Return average SOC
    return socValues.reduce((sum, soc) => sum + soc, 0) / socValues.length;
  }
  
  // Get energy totals
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
      const energyData = inverter.getEnergyData();
      
      if (energyData.solarWh > 0) {
        totals.solarWh += energyData.solarWh;
        hasSolar = true;
      }
      
      if (energyData.batteryInWh > 0 || energyData.batteryOutWh > 0) {
        totals.batteryInWh += energyData.batteryInWh;
        totals.batteryOutWh += energyData.batteryOutWh;
        hasBattery = true;
      }
      
      if (inverter.getIsMaster() && (energyData.gridInWh > 0 || energyData.gridOutWh > 0)) {
        totals.gridInWh += energyData.gridInWh;
        totals.gridOutWh += energyData.gridOutWh;
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
  
  // Get site data for frontend
  public getSiteData(): any {
    const devices = Array.from(this.inverters.values()).map(inverter => {
      const energyData = inverter.getEnergyData();
      const powerData = inverter.getLastPowerData();
      const cachedDevice = this.devices.get(inverter.getSerialNumber());
      
      return {
        ip: inverter.getIp(),
        hostname: inverter.getHostname(),
        serialNumber: inverter.getSerialNumber(),
        isMaster: inverter.getIsMaster(),
        name: inverter.getDisplayName(),
        info: {
          inverter: inverter.getInfo(),
          battery: inverter.getBattery(),
          meter: inverter.getMeter()
        },
        lastDataFetch: inverter.getLastDataFetch(),
        energyCounters: {
          solarWh: energyData.solarWh,
          batteryInWh: energyData.batteryInWh,
          batteryOutWh: energyData.batteryOutWh,
          gridInWh: energyData.gridInWh,
          gridOutWh: energyData.gridOutWh,
          loadWh: null  // Load is calculated at site level only
        }
      };
    });
    
    return {
      name: this.name,
      devices: devices,
      siteMetrics: this.lastSiteMetrics,
      hasFault: this.hasFault(),
      faults: this.getFaults()
    };
  }
  
  // Check for faults
  public hasFault(): boolean {
    for (const inverter of this.inverters.values()) {
      if (inverter.getFaultCode() !== undefined) {
        return true;
      }
    }
    return false;
  }
  
  // Get faults
  public getFaults(): Array<{serialNumber: string, faultCode: string | number, timestamp?: Date}> {
    const faults: Array<{serialNumber: string, faultCode: string | number, timestamp?: Date}> = [];
    
    for (const inverter of this.inverters.values()) {
      const faultCode = inverter.getFaultCode();
      if (faultCode) {
        faults.push({
          serialNumber: inverter.getSerialNumber(),
          faultCode: faultCode,
          timestamp: inverter.getFaultTimestamp()
        });
      }
    }
    
    return faults;
  }
  
  // Get historical data (returns siteMetrics history)
  public getHistoricalData(): any[] {
    return this.siteMetricsHistory;
  }
  
  // Get energy counters
  public getEnergyCounters(serialNumber?: string): any {
    if (serialNumber) {
      const inverter = this.inverters.get(serialNumber);
      if (inverter) {
        const energyData = inverter.getEnergyData();
        return {
          solarWh: energyData.solarWh,
          batteryInWh: energyData.batteryInWh,
          batteryOutWh: energyData.batteryOutWh,
          gridInWh: energyData.gridInWh,
          gridOutWh: energyData.gridOutWh,
          loadWh: 0
        };
      }
      return null;
    }
    
    return this.getEnergyTotals();
  }
  
  // Generate and emit FroniusMinutely report
  private generateAndEmitFroniusMinutely(): void {
    const froniusMinutely = this.generateFroniusMinutely();
    
    if (froniusMinutely) {
      this.emit('froniusMinutely', froniusMinutely);
    }
  }
  
  // Generate FroniusMinutely report
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
      const powerData = inverter.getLastPowerData();
      if (powerData?.solarW) {
        if (inverter.getIsMaster()) {
          masterPowerW += powerData.solarW;
        } else {
          slavePowerW += powerData.solarW;
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
      
      // Total accumulated values (we can track these later if needed)
      solarKwhTotal: null,
      loadKwhTotal: null,
      batteryInKwhTotal: null,
      batteryOutKwhTotal: null,
      gridInKwhTotal: null,
      gridOutKwhTotal: null
    };
    
    // Add to history
    this.froniusMinutelyHistory.push(froniusMinutely);
    
    // Keep only last 20 reports
    if (this.froniusMinutelyHistory.length > 20) {
      this.froniusMinutelyHistory = this.froniusMinutelyHistory.slice(-20);
    }
    
    return froniusMinutely;
  }
  
  // Get FroniusMinutely history
  public getFroniusMinutelyHistory(): FroniusMinutely[] {
    return this.froniusMinutelyHistory;
  }
  
  // Get site info for SSE
  public getSiteInfo(): any {
    return this.getSiteData();
  }
  
  // Get the latest site metrics
  public getLatestSiteMetrics(): any {
    return this.lastSiteMetrics;
  }
  
  // Get inverters
  public getInverters(): Inverter[] {
    return Array.from(this.inverters.values());
  }
  
  // Get master inverters
  public getMasterInverters(): Inverter[] {
    return this.getInverters().filter(inv => inv.getIsMaster());
  }
  
  // Legacy compatibility methods
  public getStatus() {
    return {
      deviceCount: this.inverters.size,
      lastScan: this.lastScan,
      isScanning: this.isScanning,
      devices: this.getDevices(),
      site: this.getSiteInfo()
    };
  }
  
  public getDevices() {
    return Array.from(this.inverters.values()).map(inverter => {
      const inverterInfo = inverter.getInfo();
      const battery = inverter.getBattery();
      const meter = inverter.getMeter();
      const lastPowerData = inverter.getLastPowerData();
      const lastDataFetch = inverter.getLastDataFetch();
      
      return {
        ip: inverter.getIp(),
        serialNumber: inverter.getSerialNumber(),
        name: inverter.getDisplayName(),
        isMaster: inverter.getIsMaster(),
        hostname: inverter.getHostname(),
        info: {
          inverter: inverterInfo,
          battery: battery,
          meter: meter
        },
        lastUpdated: lastPowerData?.timestamp,
        lastDataFetch: lastDataFetch,
        faultCode: inverter.getFaultCode(),
        faultTimestamp: inverter.getFaultTimestamp()
      };
    });
  }
  
  public getFormattedEnergyCounters(serialNumber?: string): any {
    return this.getEnergyCounters(serialNumber);
  }
}

// Singleton instance
let siteInstance: Site | null = null;

export function getSite(): Site {
  if (!siteInstance) {
    siteInstance = new Site();
    siteInstance.startPolling(2000);
    siteInstance.scanForDevices();
  }
  return siteInstance;
}