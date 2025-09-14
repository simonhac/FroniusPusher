export interface FroniusMinutely {
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