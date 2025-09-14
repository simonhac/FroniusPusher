import { NextRequest, NextResponse } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';
import { formatLocalDateTime } from '@/lib/date-utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const deviceManager = getDeviceManager();
    const history = deviceManager.getHistory();
    
    // Convert Map to object for JSON serialization with formatting
    const historyObject: any = {};
    if (history instanceof Map) {
      history.forEach((dataPoints, ip) => {
        // Format each data point
        const formattedData = dataPoints.map((point: any) => ({
          timestamp: formatLocalDateTime(new Date(point.timestamp)),
          solar: point.solar !== undefined ? Math.round(point.solar) : undefined,
          battery: point.battery !== undefined ? Math.round(point.battery) : undefined,
          grid: point.grid !== undefined ? Math.round(point.grid) : undefined,
          load: point.load !== undefined ? Math.round(point.load) : undefined,
          soc: point.soc !== undefined ? Math.round(point.soc * 10) / 10 : undefined
        }));
        historyObject[ip] = formattedData;
      });
    }
    
    return NextResponse.json({
      success: true,
      history: historyObject
    });
  } catch (error) {
    console.error('Error getting history:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}