export interface FroniusMinutely {
  timestamp: string;  // ISO 8601 format timestamp
  sequence: string;   // Format: "XXXX/N" where XXXX is base64-encoded 24-bit random (4 chars), N is incrementing decimal
  solarW: number;
  solarWhInterval: number;
  
  solarLocalW: number;
  solarLocalWhInterval: number;
  
  solarRemoteW: number;
  solarRemoteWhInterval: number;
  
  loadW: number;
  loadWhInterval: number;
  
  batteryW: number;
  batteryInWhInterval: number;
  batteryOutWhInterval: number;
  
  gridW: number;
  gridInWhInterval: number;
  gridOutWhInterval: number;
  
  batterySOC: number | null;
  
  faultCode: string | number | null;
  faultTimestamp: string | null;  // Formatted using formatLocalDateTime
  
  generatorStatus: null;  // Fronius doesn't have generator
}