export interface BatteryInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  capacityWh?: number;
  enabled?: boolean;
}

export interface InverterInfo {
  manufacturer: string;
  model: string;
  pvPowerW: number;
  customName: string;
  serialNumber: string;
}

export interface MeterInfo {
  manufacturer?: string;
  model?: string;
  serial?: string;
  location?: string;
  enabled?: boolean;
}

export interface DeviceInfo {
  inverter: InverterInfo;
  battery?: BatteryInfo;
  meter?: MeterInfo;
}