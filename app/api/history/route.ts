import { NextRequest, NextResponse } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';

// Helper function to format date in local timezone with offset
function formatLocalDateTime(date: Date): string {
  // Get timezone offset in minutes and convert to hours and minutes
  const offset = -date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  const offsetSign = offset >= 0 ? '+' : '-';
  const offsetString = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMinutes).padStart(2, '0')}`;
  
  // Format the date in local time
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetString}`;
}

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