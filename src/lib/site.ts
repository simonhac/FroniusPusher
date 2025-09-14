import { EnergyIntegrator, BidirectionalEnergyIntegrator } from './energy-integrator';
import { FroniusMinutely } from '@/types/fronius';
import { formatLocalDateTime } from './date-utils';

export interface InverterDevice {
  serialNumber: string;
  ip: string;
  hostname?: string;
  isMaster: boolean;
  name: string;
  
  // Energy integrators (null until capability is found)
  solarIntegrator: EnergyIntegrator | null;
  batteryIntegrator: BidirectionalEnergyIntegrator | null;
  gridIntegrator: BidirectionalEnergyIntegrator | null;
  
  // Current power values
  currentPower: {
    solar?: number;
    battery?: number;
    grid?: number;
    load?: number;  // Raw load from master (unreliable)
    soc?: number;
  };
  
  // Latest data from API
  lastData?: any;
  lastDataFetch?: Date;
  faultCode?: string | number;
  faultTimestamp?: Date;
}

export class Site {
  private name: string;
  private inverters: Map<string, InverterDevice> = new Map();
  private sessionId: string;
  private sequenceNumber: number = 0;
  private lastEnergySnapshot: Map<string, any> = new Map();
  private froniusMinutelyHistory: FroniusMinutely[] = [];  // Store last 10 reports
  
  constructor(name: string = 'Default Site') {
    this.name = name;
    this.sessionId = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0').toUpperCase();
  }
  
  /**
   * Add an inverter to the site
   */
  addInverter(inverter: InverterDevice): void {
    this.inverters.set(inverter.serialNumber, inverter);
  }
  
  /**
   * Remove an inverter from the site
   */
  removeInverter(serialNumber: string): void {
    this.inverters.delete(serialNumber);
  }
  
  /**
   * Get an inverter by serial number
   */
  getInverter(serialNumber: string): InverterDevice | undefined {
    return this.inverters.get(serialNumber);
  }
  
  /**
   * Get all inverters
   */
  getInverters(): InverterDevice[] {
    return Array.from(this.inverters.values());
  }
  
  /**
   * Get master inverters
   */
  getMasterInverters(): InverterDevice[] {
    return this.getInverters().filter(inv => inv.isMaster);
  }
  
  /**
   * Get slave inverters
   */
  getSlaveInverters(): InverterDevice[] {
    return this.getInverters().filter(inv => !inv.isMaster);
  }
  
  /**
   * Calculate the site's total load power in watts
   * Load = Solar + Battery Discharge + Grid Import - Battery Charge - Grid Export
   * Returns null if no inverters are connected
   */
  calculateLoadPowerW(): number | null {
    if (this.inverters.size === 0) {
      return null;
    }
    
    let totalSolar = 0;
    let totalBatteryPower = 0;
    let totalGridPower = 0;
    let hasData = false;
    
    for (const inverter of this.inverters.values()) {
      // Solar is always positive or zero
      if (inverter.currentPower.solar !== undefined) {
        totalSolar += inverter.currentPower.solar;
        hasData = true;
      }
      
      // Battery: positive = discharge, negative = charge
      if (inverter.currentPower.battery !== undefined) {
        totalBatteryPower += inverter.currentPower.battery;
        hasData = true;
      }
      
      // Grid: positive = import, negative = export
      if (inverter.currentPower.grid !== undefined) {
        totalGridPower += inverter.currentPower.grid;
        hasData = true;
      }
    }
    
    if (!hasData) {
      return null;
    }
    
    // Calculate load: Solar + Battery Discharge + Grid Import
    // Battery discharge is positive, charge is negative
    // Grid import is positive, export is negative
    const loadPower = totalSolar + totalBatteryPower + totalGridPower;
    
    return Math.max(0, loadPower); // Ensure non-negative
  }
  
  /**
   * Update all inverter integrators with current power values
   */
  updateInverterIntegrators(timestamp: Date = new Date()): void {
    // This method should be called to update individual inverter integrators
    // The actual integration happens at the inverter level
    // Site-level totals are calculated, not integrated
  }
  
  /**
   * Get the site's total solar power in watts
   * Returns null if no inverters are connected
   */
  getTotalSolarPowerW(): number | null {
    if (this.inverters.size === 0) return null;
    
    return this.getInverters().reduce((sum, inv) => 
      sum + (inv.currentPower.solar || 0), 0);
  }
  
  /**
   * Get the site's total battery power in watts
   */
  getTotalBatteryPowerW(): number {
    // Sum battery power from all inverters that have batteries
    return this.getInverters().reduce((sum, inv) => 
      sum + (inv.currentPower.battery || 0), 0);
  }
  
  /**
   * Get the site's total grid power in watts
   */
  getTotalGridPowerW(): number {
    // Only master reports grid
    const masters = this.getMasterInverters();
    if (masters.length === 0) return 0;
    return masters[0].currentPower.grid || 0;
  }
  
  /**
   * Get the site's battery SOC
   * Returns the average SOC if multiple batteries exist
   */
  getBatterySOC(): number | null {
    const socValues = this.getInverters()
      .map(inv => inv.currentPower.soc)
      .filter(soc => soc !== undefined && soc !== null);
    
    if (socValues.length === 0) return null;
    
    // Return average SOC if multiple batteries
    return socValues.reduce((sum, soc) => sum + soc, 0) / socValues.length;
  }
  
  /**
   * Get site energy totals in kWh
   * Solar: calculated by summing all inverter solar integrators
   * Load: calculated using energy balance formula
   */
  getEnergyTotals(): {
    solar: number;
    batteryIn: number;
    batteryOut: number;
    gridIn: number;
    gridOut: number;
    load: number;
  } {
    let totals = {
      solar: 0,
      batteryIn: 0,
      batteryOut: 0,
      gridIn: 0,
      gridOut: 0,
      load: 0
    };
    
    // Calculate solar by summing all inverter solar integrators
    for (const inverter of this.inverters.values()) {
      if (inverter.solarIntegrator) {
        totals.solar += inverter.solarIntegrator.getTotalKwh();
      }
    }
    
    // Battery can be on any inverter, grid only on master
    for (const inverter of this.inverters.values()) {
      // Battery - any inverter can have one
      if (inverter.batteryIntegrator) {
        totals.batteryOut += inverter.batteryIntegrator.getPositiveKwh(); // Discharge
        totals.batteryIn += inverter.batteryIntegrator.getNegativeKwh();  // Charge
      }
      
      // Grid - only master has grid connection
      if (inverter.isMaster && inverter.gridIntegrator) {
        totals.gridIn += inverter.gridIntegrator.getPositiveKwh();  // Import
        totals.gridOut += inverter.gridIntegrator.getNegativeKwh(); // Export
      }
    }
    
    // Calculate load using energy balance:
    // Load = Solar + Grid Import + Battery Discharge - Grid Export - Battery Charge
    totals.load = totals.solar + totals.gridIn + totals.batteryOut - totals.gridOut - totals.batteryIn;
    totals.load = Math.max(0, totals.load); // Ensure non-negative
    
    return totals;
  }
  
  /**
   * Get site name
   */
  getName(): string {
    return this.name;
  }
  
  /**
   * Set site name
   */
  setName(name: string): void {
    this.name = name;
  }
  
  /**
   * Check if any inverter has a fault
   */
  hasFault(): boolean {
    return Array.from(this.inverters.values()).some(inv => inv.faultCode !== undefined);
  }
  
  /**
   * Get all faults
   */
  getFaults(): Array<{serialNumber: string, faultCode: string | number, timestamp?: Date}> {
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

  /**
   * Generate FroniusMinutely report
   * This should be called once per minute to generate the energy delta report
   */
  generateFroniusMinutely(): FroniusMinutely | null {
    const energyTotals = this.getEnergyTotals();
    
    // Convert to Wh for reporting
    const totalCurrentWh = {
      solar: energyTotals.solar * 1000,
      batteryIn: energyTotals.batteryIn * 1000,
      batteryOut: energyTotals.batteryOut * 1000,
      gridIn: energyTotals.gridIn * 1000,
      gridOut: energyTotals.gridOut * 1000,
      load: energyTotals.load * 1000
    };
    
    const lastSnapshot = this.lastEnergySnapshot.get('total');
    
    if (!lastSnapshot) {
      // First snapshot - initialize
      this.lastEnergySnapshot.set('total', totalCurrentWh);
      this.lastEnergySnapshot.set('master', { solar: 0 });
      this.lastEnergySnapshot.set('slave', { solar: 0 });
      return null;
    }
    
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
    let masterPowerW = 0;
    let slavePowerW = 0;
    
    for (const inverter of this.inverters.values()) {
      if (inverter.currentPower.solar) {
        if (inverter.isMaster) {
          masterPowerW += inverter.currentPower.solar;
        } else {
          slavePowerW += inverter.currentPower.solar;
        }
      }
    }
    
    const masterSnapshot = this.lastEnergySnapshot.get('master') || { solar: 0 };
    const slaveSnapshot = this.lastEnergySnapshot.get('slave') || { solar: 0 };
    
    // Approximate master/slave split based on current power ratio
    const totalSolarPowerW = masterPowerW + slavePowerW;
    let masterSolarIntervalWh = 0;
    let slaveSolarIntervalWh = 0;
    
    if (totalSolarPowerW > 0 && deltaWh.solar > 0) {
      const masterRatio = masterPowerW / totalSolarPowerW;
      masterSolarIntervalWh = Math.round(deltaWh.solar * masterRatio);
      slaveSolarIntervalWh = deltaWh.solar - masterSolarIntervalWh;
    }
    
    // Update master/slave snapshots
    this.lastEnergySnapshot.set('master', { solar: masterSnapshot.solar + masterSolarIntervalWh });
    this.lastEnergySnapshot.set('slave', { solar: slaveSnapshot.solar + slaveSolarIntervalWh });
    
    // Increment sequence number
    this.sequenceNumber++;
    
    // Get fault information
    const faults = this.getFaults();
    let faultCode: string | number | null = null;
    let faultTimestamp: string | null = null;
    
    if (faults.length > 0) {
      faultCode = faults[0].faultCode;
      faultTimestamp = faults[0].timestamp ? formatLocalDateTime(faults[0].timestamp) : null;
    }
    
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
      
      loadW: Math.round(this.calculateLoadPowerW() || 0),
      loadIntervalWh: deltaWh.load,
      
      batteryW: Math.round(this.getTotalBatteryPowerW()),
      batteryInIntervalWh: deltaWh.batteryIn,
      batteryOutIntervalWh: deltaWh.batteryOut,
      
      gridW: Math.round(this.getTotalGridPowerW()),
      gridInIntervalWh: deltaWh.gridIn,
      gridOutIntervalWh: deltaWh.gridOut,
      
      batterySOC: this.getBatterySOC() !== null ? Math.round(this.getBatterySOC()! * 10) / 10 : null,
      
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
    };
    
    // Store in history (keep last 10)
    this.froniusMinutelyHistory.push(froniusMinutely);
    if (this.froniusMinutelyHistory.length > 10) {
      this.froniusMinutelyHistory.shift();
    }
    
    return froniusMinutely;
  }
  
  /**
   * Get the history of FroniusMinutely reports
   */
  getFroniusMinutelyHistory(): FroniusMinutely[] {
    return [...this.froniusMinutelyHistory];
  }
}