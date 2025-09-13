'use client';

import { useState, useEffect, useRef } from 'react';
import { formatDistance } from 'date-fns';
import dynamic from 'next/dynamic';

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

export default function Home() {
  const [devices, setDevices] = useState<FroniusDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<FroniusDevice | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [, forceUpdate] = useState({});
  const [historicalData, setHistoricalData] = useState<Map<string, any[]>>(new Map());
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [energyCounters, setEnergyCounters] = useState<Map<string, any>>(new Map());

  // Initialize SSE connection
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
        setScanStatus(status.message);
        
        if (status.status === 'started' || status.status === 'scanning') {
          setIsScanning(true);
        } else if (status.status === 'completed' || status.status === 'error') {
          setIsScanning(false);
          // Clear status message after 3 seconds
          setTimeout(() => setScanStatus(null), 3000);
        }
      });

      // Handle energy delta updates (once per minute)
      eventSource.addEventListener('energyDeltas', (event) => {
        const data = JSON.parse(event.data);
        const timestamp = new Date(data.timestamp).toLocaleTimeString();
        
        console.log(`[${timestamp}] Energy Delta (Wh):`, data.delta);
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
        
        // Store energy counters
        if (update.energyCounters) {
          setEnergyCounters(prev => {
            const newMap = new Map(prev);
            newMap.set(update.ip, update.energyCounters);
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
        if (data.success && data.devices) {
          setDevices(data.devices);
          setInitialLoadComplete(true);
          if (data.lastScan) {
            setLastUpdate(new Date(data.lastScan));
          }
          // Auto-select first master device or first device
          const master = data.devices.find((d: FroniusDevice) => d.isMaster);
          if (master) {
            setSelectedDevice(master);
          } else if (data.devices.length > 0) {
            setSelectedDevice(data.devices[0]);
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
      setScanStatus('Error initiating scan');
      setIsScanning(false);
      setTimeout(() => setScanStatus(null), 3000);
    }
  };

  const DeviceIcon = ({ device }: { device: FroniusDevice }) => {
    if (device.isMaster) {
      return (
        <svg className="w-6 h-6 text-yellow-500" fill="currentColor" viewBox="0 0 20 20">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
        </svg>
      );
    }
    return (
      <svg className="w-6 h-6 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm0-2a6 6 0 100-12 6 6 0 000 12z" clipRule="evenodd" />
      </svg>
    );
  };

  return (
    <div className="min-h-screen bg-black p-6">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-3xl font-bold text-white">Fronius Pusher</h1>
          </div>
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
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span>Scan</span>
              </>
            )}
          </button>
        </div>
        {scanStatus && (
          <p className="text-sm text-blue-400 mt-2 font-medium">
            {scanStatus}
          </p>
        )}
      </div>

      {/* Inverter Panels */}
      <div>
        {!initialLoadComplete ? (
          <div className="flex items-center justify-center h-64">
            <div className="bg-transparent rounded-lg p-6 text-center">
              <p className="text-gray-500 text-lg">Loading inverters...</p>
            </div>
          </div>
        ) : devices.length === 0 ? (
          <div className="bg-gray-800 rounded p-6 text-center">
            <svg className="w-12 h-12 mx-auto mb-2 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <p className="text-gray-400">No devices found</p>
            <p className="text-sm text-gray-500 mt-1">Click scan to discover devices</p>
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
              className="bg-black rounded flex items-center"
            >
              <img 
                src="/images/Gen24.webp" 
                alt="Fronius Inverter" 
                className="w-48 h-48 object-contain"
              />
              <div className="flex-1">
                <div className="flex items-center space-x-3">
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
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </a>
                    {/* Tooltip */}
                    <div className="absolute invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-1000 bg-gray-800 text-white p-3 rounded-lg shadow-xl z-50 left-0 top-8 min-w-max">
                      <div className="text-sm space-y-1">
                        {device.hostname && <p>Hostname: {device.hostname}</p>}
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
                  <div className="grid grid-cols-4 gap-2 mt-4">
                    {/* Solar */}
                    {device.data.Body.Data.Site.P_PV !== undefined && device.data.Body.Data.Site.P_PV !== null && (
                      <div className="bg-gray-900 p-2 rounded">
                        <p className="text-xs text-gray-500">Solar</p>
                        <div className="flex items-center space-x-2">
                          <svg className="w-6 h-6 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                          </svg>
                          <span className="text-2xl font-bold text-yellow-400">
                            {(device.data.Body.Data.Site.P_PV / 1000).toFixed(1)}
                            <span className="text-sm font-normal ml-1">kW</span>
                          </span>
                        </div>
                      </div>
                    )}
                    
                    {/* Battery */}
                    {device.data.Body.Data.Site.P_Akku !== undefined && device.data.Body.Data.Site.P_Akku !== null && (
                      <div className="bg-gray-900 p-2 rounded">
                        <p className="text-xs text-gray-500">Battery</p>
                        <div className="flex items-center space-x-2">
                          <svg className="w-6 h-6 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M4 6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-2h2a1 1 0 001-1v-2a1 1 0 00-1-1h-2V8a2 2 0 00-2-2H4zm0 2h12v8H4V8z"/>
                          </svg>
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
                      <div className="bg-gray-900 p-2 rounded">
                        <p className="text-xs text-gray-500">Load</p>
                        <div className="flex items-center space-x-2">
                          <svg className="w-6 h-6 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                          </svg>
                          <span className="text-2xl font-bold text-orange-400">
                            {(Math.abs(device.data.Body.Data.Site.P_Load) / 1000).toFixed(1)}
                            <span className="text-sm font-normal ml-1">kW</span>
                          </span>
                        </div>
                      </div>
                    )}
                    
                    {/* Grid */}
                    {device.data.Body.Data.Site.P_Grid !== undefined && device.data.Body.Data.Site.P_Grid !== null && (
                      <div className="bg-gray-900 p-2 rounded">
                        <p className="text-xs text-gray-500">Grid</p>
                        <div className="flex items-center space-x-2">
                          <svg className="w-6 h-6 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
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
            .filter(device => energyCounters.has(device.ip))
            .map(device => ({
              ip: device.ip,
              name: device.info?.CustomName || device.hostname?.split('.')[0] || device.ip,
              energyCounters: energyCounters.get(device.ip)!
            }))}
        />
      )}

    </div>
  );
}