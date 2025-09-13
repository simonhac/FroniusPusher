'use client';

import { useEffect, useRef } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartOptions,
  TooltipItem
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { format } from 'date-fns';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface DataPoint {
  timestamp: Date;
  solar?: number;
  battery?: number;
  grid?: number;
  load?: number;
  soc?: number;
}

interface DeviceData {
  ip: string;
  name: string;
  data: DataPoint[];
}

interface PowerChartProps {
  devices: DeviceData[];
}

export default function PowerChart({ devices }: PowerChartProps) {
  const chartRef = useRef<any>(null);

  // Get the most recent timestamp across all devices or use current time
  const allData = devices.flatMap(d => d.data);
  const latestTimestamp = allData.length > 0 
    ? new Date(Math.max(...allData.map(d => d.timestamp.getTime())))
    : new Date();
  
  // Calculate 10 minutes ago from the latest timestamp
  const tenMinutesAgo = new Date(latestTimestamp.getTime() - 10 * 60 * 1000);
  
  // Create a complete time series with 2-second intervals (matching our polling rate)
  const timeLabels: string[] = [];
  const timePoints: Date[] = [];
  for (let time = tenMinutesAgo.getTime(); time <= latestTimestamp.getTime(); time += 2000) {
    const date = new Date(time);
    timePoints.push(date);
    timeLabels.push(format(date, 'HH:mm:ss'));
  }
  
  // Map data to the complete time series
  const mapDataToTimeSeries = (dataPoints: DataPoint[], getValue: (point: DataPoint) => number | undefined) => {
    return timePoints.map(time => {
      const point = dataPoints.find(p => 
        Math.abs(p.timestamp.getTime() - time.getTime()) < 1000  // Allow 1 second tolerance for 2-second intervals
      );
      if (point) {
        const value = getValue(point);
        return value !== undefined ? value / 1000 : null;
      }
      return null;
    });
  };

  // Prepare chart data (convert W to kW)
  const datasets: any[] = [];
  
  // Calculate combined totals for battery, load, and grid first
  const combinedBattery = timePoints.map(time => {
    let total = 0;
    let hasData = false;
    devices.forEach(device => {
      const point = device.data.find(p => 
        Math.abs(p.timestamp.getTime() - time.getTime()) < 1000
      );
      if (point?.battery !== undefined) {
        total += point.battery;
        hasData = true;
      }
    });
    return hasData ? total / 1000 : null;
  });
  
  const combinedGrid = timePoints.map(time => {
    let total = 0;
    let hasData = false;
    devices.forEach(device => {
      const point = device.data.find(p => 
        Math.abs(p.timestamp.getTime() - time.getTime()) < 1000
      );
      if (point?.grid !== undefined) {
        total += point.grid;
        hasData = true;
      }
    });
    return hasData ? total / 1000 : null;
  });
  
  const combinedLoad = timePoints.map(time => {
    let total = 0;
    let hasData = false;
    devices.forEach(device => {
      const point = device.data.find(p => 
        Math.abs(p.timestamp.getTime() - time.getTime()) < 1000
      );
      if (point?.load !== undefined) {
        total += Math.abs(point.load);
        hasData = true;
      }
    });
    return hasData ? total / 1000 : null;
  });
  
  // Add datasets in order for legend: Solar, Battery, Load, Grid
  // First add solar datasets
  const solarColors = ['rgba(255, 235, 59, 0.2)', 'rgba(255, 241, 118, 0.2)', 'rgba(255, 249, 196, 0.2)'];
  devices.forEach((device, index) => {
    const filteredData = device.data.filter(point => point.timestamp >= tenMinutesAgo);
    if (filteredData.some(p => p.solar !== undefined)) {
      datasets.push({
        label: `Solar ${device.name}`,
        data: mapDataToTimeSeries(filteredData, point => point.solar),
        borderColor: solarColors[index % solarColors.length].replace('0.2', '0.6'),
        backgroundColor: solarColors[index % solarColors.length],
        borderWidth: 1,
        tension: 0.1,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: true,
        fill: true,
        stack: 'solar',
        order: 1 // Lower order for solar to appear first in legend
      });
    }
  });
  
  // Then add Battery
  if (combinedBattery.some(val => val !== null)) {
    datasets.push({
      label: 'Battery',
      data: combinedBattery,
      borderColor: 'rgb(59, 130, 246)',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
      order: 2 // Battery second in legend
    });
  }
  
  // Then add Load
  if (combinedLoad.some(val => val !== null)) {
    datasets.push({
      label: 'Load',
      data: combinedLoad,
      borderColor: 'rgb(249, 115, 22)',
      backgroundColor: 'rgba(249, 115, 22, 0.1)',
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
      order: 3 // Load third in legend
    });
  }
  
  // Finally add Grid
  if (combinedGrid.some(val => val !== null)) {
    datasets.push({
      label: 'Grid',
      data: combinedGrid,
      borderColor: 'rgb(147, 51, 234)',
      backgroundColor: 'rgba(147, 51, 234, 0.1)',
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
      order: 4 // Grid last in legend
    });
  }
  
  const chartData = {
    labels: timeLabels,
    datasets: datasets
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: {
          usePointStyle: true,
          padding: 15,
          font: {
            size: 12,
            family: 'DM Sans, sans-serif'
          },
          color: 'rgb(156, 163, 175)'
        }
      },
      tooltip: {
        callbacks: {
          label: function(context: TooltipItem<'line'>) {
            let label = context.dataset.label || '';
            if (label) {
              label += ': ';
            }
            if (context.parsed.y !== null) {
              label += context.parsed.y.toFixed(3) + ' kW';
            }
            return label;
          }
        }
      }
    },
    scales: {
      x: {
        display: true,
        title: {
          display: false
        },
        ticks: {
          maxTicksLimit: 10,
          maxRotation: 0,
          font: {
            size: 15,  // Increased by 50% from 10
            family: 'DM Sans, sans-serif'
          },
          color: 'rgb(156, 163, 175)',
          callback: function(value, index, values) {
            // Show every 60th label (approximately every minute if data points are every second)
            // Or show first and last labels
            const label = this.getLabelForValue(value as number);
            if (index === 0 || index === values.length - 1 || index % 60 === 0) {
              // Return HH:mm format
              return label ? label.substring(0, 5) : '';
            }
            return '';
          },
          autoSkip: false
        },
        grid: {
          display: true,
          color: 'rgba(255, 255, 255, 0.1)'
        }
      },
      y: {
        display: true,
        title: {
          display: false
        },
        // Set minimum to -1 if we have battery data, but allow it to go lower if needed
        suggestedMin: combinedBattery.some(val => val !== null) ? -1.0 : undefined,
        ticks: {
          stepSize: 1.0,  // Force ticks at multiples of 1.0 kW
          font: {
            size: 15,  // Increased by 50% from 10
            family: 'DM Sans, sans-serif'
          },
          color: 'rgb(156, 163, 175)',
          callback: function(value, index, values) {
            const roundedValue = Math.round(value as number);
            // Only add 'kW' to the top label (last in the array)
            if (index === values.length - 1) {
              return roundedValue + ' kW';
            }
            return roundedValue.toString();
          }
        },
        grid: {
          color: (context) => {
            // Make the zero line thicker and more visible
            if (context.tick.value === 0) {
              return 'rgba(255, 255, 255, 0.3)';
            }
            return 'rgba(255, 255, 255, 0.1)';
          },
          lineWidth: (context) => {
            // Triple thickness for zero line
            if (context.tick.value === 0) {
              return 3;
            }
            return 1;
          }
        }
      }
    },
    animation: {
      duration: 0
    }
  };

  // Update chart when data changes
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.update('none');
    }
  }, [devices]);

  if (allData.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center bg-transparent rounded-lg">
        <p className="text-gray-500">Collecting data...</p>
      </div>
    );
  }

  return (
    <div className="h-64 bg-transparent rounded-lg">
      <Line ref={chartRef} options={options} data={chartData} />
    </div>
  );
}