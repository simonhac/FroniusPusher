'use client';

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Sun, Battery, Home, Zap } from 'lucide-react';
import { FroniusMinutely } from '@/types/fronius';

interface FroniusMinutelyDisplayProps {
  history: FroniusMinutely[];
}

export default function FroniusMinutelyDisplay({ history }: FroniusMinutelyDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const formatTimestamp = (timestamp: string) => {
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch {
      return timestamp;
    }
  };

  const getStatusText = () => {
    if (history.length === 0) {
      return 'Not yet reported';
    }
    const latest = history[history.length - 1];
    return `Reported at ${formatTimestamp(latest.timestamp)}`;
  };

  const formatPowerValue = (value: number | null) => {
    if (value === null || value === undefined) return '—';
    return (value / 1000).toFixed(1);
  };

  const formatEnergyValue = (value: number | null) => {
    if (value === null || value === undefined) return '—';
    return value.toLocaleString();
  };

  const formatBatteryPower = (powerW: number | null) => {
    if (powerW === null || powerW === undefined) return '—';
    return (Math.abs(powerW) / 1000).toFixed(1);
  };

  const formatBatteryEnergy = (inValue: number | null, outValue: number | null) => {
    if (inValue === null && outValue === null) return '—';
    const netValue = (outValue || 0) - (inValue || 0);
    return netValue.toLocaleString();
  };

  const formatGridPower = (powerW: number | null) => {
    if (powerW === null || powerW === undefined) return '—';
    return (Math.abs(powerW) / 1000).toFixed(1);
  };

  const formatGridEnergy = (inValue: number | null, outValue: number | null) => {
    if (inValue === null && outValue === null) return '—';
    const netValue = (inValue || 0) - (outValue || 0);
    return netValue.toLocaleString();
  };

  return (
    <div className="mt-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center space-x-2 text-gray-400 hover:text-gray-300 transition-colors w-full"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4" />
        ) : (
          <ChevronRight className="w-4 h-4" />
        )}
        <span className="text-sm">{getStatusText()}</span>
      </button>

      {isExpanded && history.length > 0 && (
        <div className="mt-3 bg-gray-900 rounded-lg p-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="text-left py-2 pr-4 text-gray-400 font-normal" rowSpan={2}>Time</th>
                <th className="text-center py-1 px-2" colSpan={2}>
                  <Sun className="w-4 h-4 inline text-yellow-400" />
                </th>
                <th className="w-4" rowSpan={2}></th>
                <th className="text-center py-1 px-2" colSpan={3}>
                  <Battery className="w-4 h-4 inline text-blue-400" />
                </th>
                <th className="w-4" rowSpan={2}></th>
                <th className="text-center py-1 px-2" colSpan={2}>
                  <Home className="w-4 h-4 inline text-orange-400" />
                </th>
                <th className="w-4" rowSpan={2}></th>
                <th className="text-center py-1 px-2" colSpan={2}>
                  <Zap className="w-4 h-4 inline text-purple-400" />
                </th>
              </tr>
              <tr className="border-b border-gray-700 text-xs">
                <th className="text-right py-1 px-1 text-gray-500 font-normal">kW</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">Wh</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">kW</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">Wh</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">%</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">kW</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">Wh</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">kW</th>
                <th className="text-right py-1 px-1 text-gray-500 font-normal">Wh</th>
              </tr>
            </thead>
            <tbody>
              {history.slice().reverse().slice(0, 10).map((report, index) => (
                <tr key={index} className={index > 0 ? "border-t border-gray-800" : ""}>
                  <td className="py-1 pr-4 text-gray-200 font-mono text-sm">
                    {formatTimestamp(report.timestamp)}
                  </td>
                  {/* Solar */}
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatPowerValue(report.solarW)}
                  </td>
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatEnergyValue(report.solarIntervalWh)}
                  </td>
                  <td className="w-4"></td>
                  {/* Battery */}
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatBatteryPower(report.batteryW)}
                  </td>
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatBatteryEnergy(report.batteryInIntervalWh, report.batteryOutIntervalWh)}
                  </td>
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {report.batterySOC !== null ? report.batterySOC.toFixed(1) : '—'}
                  </td>
                  <td className="w-4"></td>
                  {/* Load */}
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatPowerValue(report.loadW)}
                  </td>
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatEnergyValue(report.loadIntervalWh)}
                  </td>
                  <td className="w-4"></td>
                  {/* Grid */}
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatGridPower(report.gridW)}
                  </td>
                  <td className="py-1 px-1 text-right text-gray-200 font-mono text-sm">
                    {formatGridEnergy(report.gridInIntervalWh, report.gridOutIntervalWh)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-xs text-gray-500">
            Power in kW, Energy in Wh per minute
          </div>
        </div>
      )}
    </div>
  );
}