import { NextRequest, NextResponse } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const deviceManager = getDeviceManager();
    const site = deviceManager.getSite();
    const history = site.getFroniusMinutelyHistory();
    
    return NextResponse.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error fetching FroniusMinutely history:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}