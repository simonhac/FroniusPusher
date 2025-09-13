import { NextResponse } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const ip = searchParams.get('ip');
    
    const deviceManager = getDeviceManager();
    
    if (action === 'status') {
      // Return current status and device list
      return NextResponse.json({
        success: true,
        ...deviceManager.getStatus(),
        timestamp: new Date().toISOString()
      });
    } else if (action === 'scan') {
      // Trigger a new scan
      deviceManager.scanDevices(); // Don't await - let it run in background
      return NextResponse.json({
        success: true,
        message: 'Scan initiated',
        timestamp: new Date().toISOString()
      });
    } else if (action === 'history') {
      // Get historical data for a specific device or all devices
      const history = deviceManager.getHistory(ip || undefined);
      if (ip && history === null) {
        return NextResponse.json({
          success: false,
          error: 'Device not found or no history available'
        }, { status: 404 });
      }
      
      // Convert Map to object if returning all history
      const historyData = ip 
        ? history 
        : history instanceof Map 
          ? Object.fromEntries(history as Map<string, any>) 
          : {};
      
      return NextResponse.json({
        success: true,
        history: historyData,
        timestamp: new Date().toISOString()
      });
    } else if (ip) {
      // Fetch data for specific device
      const data = await deviceManager.fetchDeviceData(ip);
      return NextResponse.json({
        success: true,
        data,
        timestamp: new Date().toISOString()
      });
    } else {
      // Return all devices with current data
      const devices = deviceManager.getDevices();
      return NextResponse.json({
        success: true,
        devices,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error in Fronius API:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred'
      },
      { status: 500 }
    );
  }
}