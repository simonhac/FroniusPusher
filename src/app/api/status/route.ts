import { NextRequest, NextResponse } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';
import { formatDateValue } from '@/lib/date-utils';

export async function GET(request: NextRequest) {
  try {
    const deviceManager = getDeviceManager();
    const status = deviceManager.getStatus();
    
    // Format dates in devices
    const formattedDevices = status.devices.map((device: any) => ({
      ...device,
      lastUpdated: formatDateValue(device.lastUpdated),
      lastDataFetch: formatDateValue(device.lastDataFetch)
    }));
    
    // Get energy counters for all devices
    const energyCounters: any = {};
    for (const device of status.devices) {
      const counters = deviceManager.getFormattedEnergyCounters(device.serialNumber);
      if (counters) {
        // Use serial number as key
        energyCounters[device.serialNumber] = counters;
      }
    }
    
    return NextResponse.json({
      success: true,
      deviceCount: status.deviceCount,
      lastScan: formatDateValue(status.lastScan),
      isScanning: status.isScanning,
      devices: formattedDevices,
      energyCounters
    });
  } catch (error) {
    console.error('Error getting status:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}