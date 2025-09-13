import { NextRequest, NextResponse } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';

export async function GET(request: NextRequest) {
  try {
    const deviceManager = getDeviceManager();
    const status = deviceManager.getStatus();
    
    return NextResponse.json({
      success: true,
      ...status
    });
  } catch (error) {
    console.error('Error getting status:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}