'use client';

import { useState, useEffect, useRef } from 'react';
import { formatDistance } from 'date-fns';
import dynamic from 'next/dynamic';
import { 
  Home as HomeIcon, 
  Sun, 
  Battery, 
  Zap, 
  Search, 
  ExternalLink,
  Star,
  Circle
} from 'lucide-react';

const PowerChart = dynamic(() => import('@/components/PowerChart'), { 
  ssr: false,
  loading: () => <div className="h-64 flex items-center justify-center bg-transparent rounded-lg">
    <p className="text-gray-500">Loading chart...</p>
  </div>
});

const EnergyTable = dynamic(() => import('@/components/EnergyTable'), { 
  ssr: false 
});

interface FroniusDevice {
  ip: string;
  mac: string;
  hostname?: string;
  isMaster: boolean;
  serialNumber: string;
  data?: any;
  info?: {
    CustomName?: string;
    DT?: number;
    StatusCode?: number;
    manufacturer?: string;
    model?: string;
  };
  lastUpdated?: string;
  lastDataFetch?: string;
}

interface SiteInfo {
  name: string;
  powerW: {
    solar: number | null;
    battery: number;
    grid: number;
    load: number | null;
  };
  energyKwh: {
    solar: number;
    batteryIn: number;
    batteryOut: number;
    gridIn: number;
    gridOut: number;
    load: number;
  };
  batterySOC: number | null;
  hasFault: boolean;
  faults: any[];
}

export default function Home() {
  const [devices, setDevices] = useState<FroniusDevice[]>([]);
  const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
  const [selectedDevice, setSelectedDevice] = useState<FroniusDevice | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [, forceUpdate] = useState({});
  const [historicalData, setHistoricalData] = useState<Map<string, any[]>>(new Map());
  const [isScanning, setIsScanning] = useState<boolean | null>(null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [energyCounters, setEnergyCounters] = useState<Map<string, any>>(new Map());

  // Initialise SSE connection
  useEffect(() => {
    const connectSSE = () => {
      // Close any existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      
      console.log('Connecting to SSE...');
      const eventSource = new EventSource('/api/sse');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        console.log('SSE connected');
        setConnected(true);
      };

      eventSource.onerror = (error) => {
        console.log('SSE connection lost, will reconnect in 5 seconds');
        setConnected(false);
        eventSource.close();
        // Reconnect after 5 seconds
        setTimeout(() => {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            connectSSE();
          }
        }, 5000);
      };

      // Handle device list updates
      eventSource.addEventListener('devices', (event) => {
        const updatedDevices = JSON.parse(event.data);
        setDevices(updatedDevices);
        setLastUpdate(new Date());
        setInitialLoadComplete(true);
        
        // Update selected device if it exists in the new list
        if (selectedDevice) {
          const updated = updatedDevices.find((d: FroniusDevice) => d.ip === selectedDevice.ip);
          if (updated) {
            setSelectedDevice(updated);
          }
        }
      });

      // Handle scan status updates
      eventSource.addEventListener('scanStatus', (event) => {
        const status = JSON.parse(event.data);
        
        if (status.status === 'started' || status.status === 'scanning') {
          setIsScanning(true);
        } else if (status.status === 'completed' || status.status === 'error') {
          setIsScanning(false);
        }
      });

      // Handle FroniusMinutely updates (once per minute)
      eventSource.addEventListener('froniusMinutely', (event) => {
        const data = JSON.parse(event.data);
        const timestamp = new Date(data.timestamp).toLocaleTimeString();
        
        console.log(`[${timestamp}] FroniusMinutely:`, data);
      });
      
      // Handle site updates
      eventSource.addEventListener('siteUpdate', (event) => {
        const site = JSON.parse(event.data);
        setSiteInfo(site);
      });

      // Handle individual device data updates
      eventSource.addEventListener('deviceData', (event) => {
        const update = JSON.parse(event.data);
        
        // Update the specific device's data
        setDevices(prevDevices => 
          prevDevices.map(device => 
            device.ip === update.ip 
              ? { ...device, data: update.data, lastDataFetch: update.timestamp }
              : device
          )
        );
        
        // Update selected device if it's the one being updated
        if (selectedDevice?.ip === update.ip) {
          setSelectedDevice(prev => prev ? { ...prev, data: update.data, lastDataFetch: update.timestamp } : null);
        }
        
        // Store energy counters (use serialNumber if available, fallback to ip)
        if (update.energyCounters) {
          setEnergyCounters(prev => {
            const newMap = new Map(prev);
            const key = update.serialNumber || update.ip;
            newMap.set(key, update.energyCounters);
            return newMap;
          });
        }
        
        // Store historical data for charts
        if (update.data?.Body?.Data?.Site) {
          const site = update.data.Body.Data.Site;
          const inverters = update.data.Body.Data.Inverters;
          const firstInverter = inverters && Object.values(inverters)[0] as any;
          
          const dataPoint = {
            timestamp: new Date(update.timestamp),
            solar: site.P_PV ?? undefined,
            battery: site.P_Akku ?? undefined,
            grid: site.P_Grid ?? undefined,
            load: site.P_Load ?? undefined,
            soc: firstInverter?.SOC ?? undefined
          };
          
          setHistoricalData(prev => {
            const newMap = new Map(prev);
            const deviceHistory = newMap.get(update.ip) || [];
            
            // Add new data point
            deviceHistory.push(dataPoint);
            
            // Keep only last 15 minutes of data
            const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
            const filteredHistory = deviceHistory.filter(point => point.timestamp >= fifteenMinutesAgo);
            
            newMap.set(update.ip, filteredHistory);
            return newMap;
          });
        }
        
        setLastUpdate(new Date(update.timestamp));
      });
    };

    connectSSE();

    // Cleanup on unmount
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Load initial status and history
  useEffect(() => {
    // Load device status
    fetch('/api/status')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          if (data.devices) {
            setDevices(data.devices);
          }
          
          // Set scanning status from API
          if (data.isScanning !== undefined) {
            setIsScanning(data.isScanning);
          }
          
          if (data.site) {
            setSiteInfo(data.site);
          }
          
          setInitialLoadComplete(true);
          
          if (data.lastScan) {
            setLastUpdate(new Date(data.lastScan));
          }
          
          // Auto-select first master device or first device
          if (data.devices && data.devices.length > 0) {
            const master = data.devices.find((d: FroniusDevice) => d.isMaster);
            if (master) {
              setSelectedDevice(master);
            } else {
              setSelectedDevice(data.devices[0]);
            }
          }
        }
      })
      .catch(error => {
        console.error(error);
        setInitialLoadComplete(true);
      });

    // Load historical data
    fetch('/api/history')
      .then(res => res.json())
      .then(data => {
        if (data.success && data.history) {
          const newHistoricalData = new Map<string, any[]>();
          for (const [ip, history] of Object.entries(data.history)) {
            // Convert timestamp strings back to Date objects
            const processedHistory = (history as any[]).map(point => ({
              ...point,
              timestamp: new Date(point.timestamp)
            }));
            newHistoricalData.set(ip, processedHistory);
          }
          setHistoricalData(newHistoricalData);
        }
      })
      .catch(error => {
        console.error('Error loading historical data:', error);
      });
  }, []);

  // Update status dots every second
  useEffect(() => {
    const interval = setInterval(() => {
      forceUpdate({});
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const scanDevices = async () => {
    try {
      const response = await fetch('/api/do', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'scan' }),
      });
      const data = await response.json();
      if (data.success) {
        // Scan initiated - updates will come via SSE
        console.log('Scan initiated');
      }
    } catch (error) {
      console.error('Error initiating scan:', error);
      setIsScanning(false);
    }
  };

  const DeviceIcon = ({ device }: { device: FroniusDevice }) => {
    if (device.isMaster) {
      return <Star className="w-6 h-6 text-yellow-500" fill="currentColor" />;
    }
    return <Circle className="w-6 h-6 text-gray-400" />;
  };

  return (
    <div className="min-h-screen bg-black p-6">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-3xl font-bold text-white">Fronius Pusher</h1>
          </div>
          {isScanning !== null && (
            <button
              onClick={scanDevices}
              disabled={isScanning}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-600 transition flex items-center space-x-2"
            >
              {isScanning ? (
              <>
                <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Scanning...</span>
              </>
            ) : (
              <>
                <Search className="w-5 h-5" />
                <span>Scan</span>
              </>
            )}
            </button>
          )}
        </div>
      </div>

      {/* Site Panel with House Icon */}
      {siteInfo && (
        <div className="bg-black rounded flex items-start mb-6">
          {/* House Icon */}
          <div className="w-40 h-40 flex items-center justify-center mr-5">
            <HomeIcon className="w-32 h-32 text-gray-400" strokeWidth={1.25} />
          </div>
          <div className="flex-1">
            <div className="flex items-center space-x-3 mt-4">
              <h3 className="text-2xl font-semibold text-white">
                {siteInfo.name}
              </h3>
              <span className="text-sm text-gray-400">Site Total</span>
            </div>
            
            {/* Site Power Cards - Order: Solar, Battery, Load, Grid */}
            <div className="flex flex-wrap gap-3 mt-4 mb-5">
              {/* Solar */}
              <div className="bg-gray-900 p-2 rounded w-[200px]">
                <p className="text-xs text-gray-500">Solar (Total)</p>
                <div className="flex items-center space-x-2">
                  <Sun className="w-6 h-6 text-yellow-400" />
                  <span className="text-2xl font-bold text-yellow-400">
                    {siteInfo.powerW.solar !== null 
                      ? <>{(siteInfo.powerW.solar / 1000).toFixed(1)}<span className="text-sm font-normal ml-1">kW</span></>
                      : 'N/A'
                    }
                  </span>
                </div>
              </div>
              
              {/* Battery */}
              {siteInfo.powerW.battery !== 0 && (
                <div className="bg-gray-900 p-2 rounded w-[200px]">
                  <p className="text-xs text-gray-500">Battery</p>
                  <div className="flex items-center space-x-2">
                    <Battery className="w-6 h-6 text-blue-400" />
                    <span className="text-2xl font-bold text-blue-400">
                      {(Math.abs(siteInfo.powerW.battery) / 1000).toFixed(1)}
                      <span className="text-sm font-normal ml-1">kW</span>
                      {siteInfo.batterySOC !== null && (
                        <>
                          <span className="text-sm font-normal mx-1">/</span>
                          {siteInfo.batterySOC.toFixed(1)}
                          <span className="text-sm font-normal ml-0.5">%</span>
                        </>
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {siteInfo.powerW.battery < 0 ? 'Charging' : 
                     siteInfo.powerW.battery > 0 ? 'Discharging' : 'Idle'}
                  </p>
                </div>
              )}
              
              {/* Load (Calculated) */}
              <div className="bg-gray-900 p-2 rounded w-[200px]">
                <p className="text-xs text-gray-500">Load (Calculated)</p>
                <div className="flex items-center space-x-2">
                  <HomeIcon className="w-6 h-6 text-orange-400" />
                  <span className="text-2xl font-bold text-orange-400">
                    {siteInfo.powerW.load !== null 
                      ? <>{(siteInfo.powerW.load / 1000).toFixed(1)}<span className="text-sm font-normal ml-1">kW</span></>
                      : 'N/A'
                    }
                  </span>
                </div>
              </div>
              
              {/* Grid */}
              {siteInfo.powerW.grid !== 0 && (
                <div className="bg-gray-900 p-2 rounded w-[200px]">
                  <p className="text-xs text-gray-500">Grid</p>
                  <div className="flex items-center space-x-2">
                    <Zap className="w-6 h-6 text-purple-400" />
                    <span className="text-2xl font-bold text-purple-400">
                      {(Math.abs(siteInfo.powerW.grid) / 1000).toFixed(1)}
                      <span className="text-sm font-normal ml-1">kW</span>
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {siteInfo.powerW.grid > 0 ? 'Importing' : 'Exporting'}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Inverter Panels */}
      <div>
        {!initialLoadComplete ? (
          <div className="flex items-center justify-center h-64">
            <div className="bg-transparent rounded-lg p-6 text-center">
              <p className="text-gray-500 text-lg">Loading inverters...</p>
            </div>
          </div>
        ) : devices.length === 0 ? (
          <div className="flex items-center justify-center h-64 bg-black rounded">
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto mb-2 text-gray-600" fill="none" 
                stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <p className="text-gray-500 text-sm">No devices found</p>
            </div>
          </div>
        ) : (
          devices
            .sort((a, b) => {
              // Sort master devices first
              if (a.isMaster && !b.isMaster) return -1;
              if (!a.isMaster && b.isMaster) return 1;
              return 0;
            })
            .map((device) => (
            <div
              key={device.ip}
              className="bg-black rounded flex items-start"
            >
              <img 
                src="/images/Gen24.png" 
                alt="Fronius Inverter" 
                className="w-40 h-40 object-contain mr-5"
              />
              <div className="flex-1">
                <div className="flex items-center space-x-3 mt-4">
                  <h3 className="text-2xl font-semibold text-white">
                    {device.info?.CustomName || 'Fronius Inverter'}
                  </h3>
                  <div className="relative group">
                    <a
                      href={`http://${device.hostname || device.ip}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-blue-400 hover:text-blue-300 transition-colors"
                    >
                      <ExternalLink className="w-5 h-5" />
                    </a>
                    {/* Tooltip */}
                    <div className="absolute invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-1000 bg-gray-800 text-white p-3 rounded-lg shadow-xl z-50 left-0 top-8 min-w-max">
                      <div className="text-sm space-y-1">
                        {device.hostname && (
                          <p>
                            Hostname:{' '}
                            <a 
                              href={`http://${device.hostname}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-400 hover:text-blue-300 underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {device.hostname}
                            </a>
                          </p>
                        )}
                        <p>IP: {device.ip}</p>
                        <p>MAC: {device.mac}</p>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className={`w-2 h-2 rounded-full ${
                      device.lastDataFetch && 
                      (new Date().getTime() - new Date(device.lastDataFetch).getTime() < 10000) 
                        ? 'bg-green-500' 
                        : 'bg-red-500'
                    }`} />
                    {device.lastDataFetch && 
                     (new Date().getTime() - new Date(device.lastDataFetch).getTime() >= 10000) && (
                      <span className="text-xs text-gray-500">
                        Last update: {formatDistance(new Date(device.lastDataFetch), new Date(), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs">
                  <span className="text-gray-400 font-medium">{device.info?.model || 'Unknown Model'}</span>
                  <span className="text-gray-500 ml-2">Serial# {device.serialNumber}</span>
                </p>
                
                {/* Power Cards */}
                {device.data?.Body?.Data?.Site && (
                  <div className="flex flex-wrap gap-3 mt-4 mb-5">
                    {/* Solar */}
                    {device.data.Body.Data.Site.P_PV !== undefined && device.data.Body.Data.Site.P_PV !== null && (
                      <div className="bg-gray-900 p-2 rounded w-[200px]">
                        <p className="text-xs text-gray-500">Solar</p>
                        <div className="flex items-center space-x-2">
                          <Sun className="w-6 h-6 text-yellow-400" />
                          <span className="text-2xl font-bold text-yellow-400">
                            {(device.data.Body.Data.Site.P_PV / 1000).toFixed(1)}
                            <span className="text-sm font-normal ml-1">kW</span>
                          </span>
                        </div>
                      </div>
                    )}
                    
                    {/* Battery */}
                    {device.data.Body.Data.Site.P_Akku !== undefined && device.data.Body.Data.Site.P_Akku !== null && (
                      <div className="bg-gray-900 p-2 rounded w-[200px]">
                        <p className="text-xs text-gray-500">Battery</p>
                        <div className="flex items-center space-x-2">
                          <Battery className="w-6 h-6 text-blue-400" />
                          <span className="text-2xl font-bold text-blue-400">
                            {(Math.abs(device.data.Body.Data.Site.P_Akku) / 1000).toFixed(1)}
                            <span className="text-sm font-normal ml-1">kW</span>
                            {(() => {
                              const inverters = device.data.Body.Data.Inverters;
                              const firstInverter = inverters && Object.values(inverters)[0] as any;
                              if (firstInverter?.SOC !== undefined && firstInverter?.SOC !== null) {
                                return (
                                  <>
                                    <span className="text-sm font-normal mx-1">/</span>
                                    {firstInverter.SOC.toFixed(1)}
                                    <span className="text-sm font-normal ml-0.5">%</span>
                                  </>
                                );
                              }
                              return null;
                            })()}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500">
                          {device.data.Body.Data.Site.P_Akku < 0 ? 'Charging' : 
                           device.data.Body.Data.Site.P_Akku > 0 ? 'Discharging' : 'Idle'}
                        </p>
                      </div>
                    )}
                    
                    {/* Load */}
                    {device.data.Body.Data.Site.P_Load !== undefined && device.data.Body.Data.Site.P_Load !== null && (
                      <div className="bg-gray-900 p-2 rounded w-[200px]">
                        <p className="text-xs text-gray-500">Load</p>
                        <div className="flex items-center space-x-2">
                          <HomeIcon className="w-6 h-6 text-orange-400" />
                          <span className="text-2xl font-bold text-orange-400">
                            {(Math.abs(device.data.Body.Data.Site.P_Load) / 1000).toFixed(1)}
                            <span className="text-sm font-normal ml-1">kW</span>
                          </span>
                        </div>
                      </div>
                    )}
                    
                    {/* Grid */}
                    {device.data.Body.Data.Site.P_Grid !== undefined && device.data.Body.Data.Site.P_Grid !== null && (
                      <div className="bg-gray-900 p-2 rounded w-[200px]">
                        <p className="text-xs text-gray-500">Grid</p>
                        <div className="flex items-center space-x-2">
                          <Zap className="w-6 h-6 text-purple-400" />
                          <span className="text-2xl font-bold text-purple-400">
                            {(Math.abs(device.data.Body.Data.Site.P_Grid) / 1000).toFixed(1)}
                            <span className="text-sm font-normal ml-1">kW</span>
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Power Chart - Below Inverters */}
      {devices.length > 0 && historicalData.size > 0 && (
        <div className="mb-6">
          <div className="bg-transparent rounded-lg">
            <PowerChart devices={
              devices.map(device => ({
                ip: device.ip,
                name: device.info?.CustomName || device.hostname?.split('.')[0] || device.ip,
                data: historicalData.get(device.ip) || []
              }))
            } />
          </div>
        </div>
      )}

      {/* Energy Table - Below Chart */}
      {devices.length > 0 && energyCounters.size > 0 && (
        <EnergyTable 
          devices={devices
            .filter(device => energyCounters.has(device.serialNumber))
            .map(device => ({
              ip: device.ip,
              name: device.info?.CustomName || device.hostname?.split('.')[0] || device.ip,
              energyCounters: energyCounters.get(device.serialNumber)!
            }))}
          siteEnergy={siteInfo?.energyKwh || null}
        />
      )}

    </div>
  );
}