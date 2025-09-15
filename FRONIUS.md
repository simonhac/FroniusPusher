# Fronius Solar API Documentation

## Overview

This document summarizes what we've learned about the Fronius Solar API v1 through practical implementation and testing with Fronius Gen24 inverters.

## API Endpoints

### Core Endpoints

#### Power Flow Data
- **Endpoint**: `/solar_api/v1/GetPowerFlowRealtimeData.fcgi`
- **Purpose**: Real-time power flow data including solar, battery, grid, and load
- **Response Time**: ~35ms (active inverter)
- **Key Data**:
  - `Site.P_PV`: Solar power generation (W)
  - `Site.P_Grid`: Grid power (+import/-export) (W)
  - `Site.P_Load`: Load consumption (W) - only on master
  - `Site.P_Akku`: Battery power (+discharge/-charge) (W)
  - `Inverters.[id].SOC`: Battery state of charge (%)

#### Inverter Information
- **Endpoint**: `/solar_api/v1/GetInverterInfo.cgi`
- **Purpose**: Basic inverter specifications
- **Key Data**:
  - `DT`: Device Type code (1 = Gen24)
  - `UniqueID`: Serial number
  - `CustomName`: User-defined name
  - `PVPower`: Installed PV capacity (W)
  - `StatusCode`: Operating status
  - `InverterState`: Text status

#### Battery/Storage Data
- **Endpoint**: `/solar_api/v1/GetStorageRealtimeData.cgi`
- **Purpose**: Battery system information
- **Key Data Structure**: `Body.Data["0"].Controller`
  - `Details.Manufacturer`: e.g., "BYD"
  - `Details.Model`: e.g., "BYD Battery-Box Premium HV"
  - `Details.Serial`: Battery serial number
  - `DesignedCapacity`: Battery capacity (Wh)
  - `StateOfCharge_Relative`: SOC percentage
  - `Temperature_Cell`: Battery temperature (°C)
  - `Voltage_DC`: Battery voltage
  - `Current_DC`: Battery current

#### Meter Data
- **Endpoint**: `/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System`
- **Purpose**: Power meter readings
- **Key Data**:
  - `Details.Manufacturer`: e.g., "Fronius"
  - `Details.Model`: e.g., "CCS WattNode WND-3D-480-MB"
  - `Meter_Location_Current`: Location code (see below)
  - Energy counters for import/export
  - Voltage and current per phase

#### Components Info
- **Endpoint**: `/api/components/inverter/readable`
- **Purpose**: Detailed component information
- **Notable**: Returns "Fronius Gen24" as model name

## Important Discoveries

### Device Type (DT) Codes
- **1**: Fronius Gen24
- Additional codes need to be discovered and mapped

### Meter Location Codes
Based on Fronius documentation:
- **0**: Grid (feed-in point)
- **1**: Load (consumption path)
- **3**: External generator
- **256-511**: Subload range
- **512-768**: EV Charger range
- **769-1023**: Storage range

### Inverter Status Codes
- **7**: Running (normal operation)
- **13**: Sleeping (nighttime/no production)

### Master vs Slave Behavior

#### Master Inverter
- Remains active 24/7
- Monitors battery, grid, and load
- Has `P_Load` data in Site object
- Manages overall system coordination
- Typical response time: ~35ms

#### Slave Inverter
- Enters sleep mode at night (StatusCode 13)
- **Solar API disabled during sleep** - endpoints timeout
- Dashboard endpoint (`/app/dashboard`) remains responsive (~300ms)
- Only provides solar production data
- No load monitoring capability
- Wakes up when solar production begins

### Network Behavior

#### During Sleep Mode
- Device remains pingable (network stack active)
- Dashboard web interface accessible
- **Solar API endpoints completely unresponsive** (30+ second timeouts)
- This is by design to save power

#### API Timeouts
- Active inverter: 35-50ms typical response
- Sleeping inverter: No response (infinite wait without timeout)
- Recommended timeout: 2-5 seconds for discovery
- Dashboard always responds even when API doesn't

### Data Structure Notes

1. **Battery Detection**: Only create battery integrators when `Controller` object exists in storage data
2. **Serial Numbers**: Use `UniqueID` field, not `Serial`
3. **Power Signs**:
   - Grid: positive = import, negative = export
   - Battery: positive = discharge, negative = charge
4. **Energy Counters**: Use nullish coalescing (`??`) not logical OR (`||`) to preserve 0 values

### Discovery Process

1. Ping subnet to populate ARP table
2. Check each IP for Fronius API (`GetAPIVersion.cgi`)
3. Identify master by presence of `P_Load` data
4. Fetch battery, inverter, and meter info during discovery
5. Store static device info (manufacturer, model, capacity)
6. Poll only power flow data during regular operation

### Best Practices

1. **Discovery**: Run discovery with longer timeouts (5-10s) to catch slow-responding devices
2. **Regular Polling**: Use short timeouts (2s) and skip unresponsive devices
3. **Night Operation**: Expect slave inverters to be unreachable
4. **Error Handling**: Gracefully handle timeout errors for sleeping inverters
5. **Data Caching**: Cache device info from discovery, don't re-fetch during polling

## API Limitations

- Limited inverter specification data compared to battery/meter info
- No detailed inverter model information beyond DT code
- Slave inverters completely unresponsive at night (API level)
- No way to wake sleeping inverters via API
- Must use master inverter for complete site overview

## Testing Results

### Response Times (Active Devices)
- Master inverter API: ~35ms
- Slave dashboard (sleeping): ~300ms
- Slave API (sleeping): No response (timeout)

### Typical Polling Configuration
- Interval: 2 seconds
- Timeout: 2 seconds
- Batch updates: Wait for all inverters before sending to frontend
- Skip sleeping inverters after initial timeout