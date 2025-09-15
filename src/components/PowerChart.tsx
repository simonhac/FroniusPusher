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

interface PowerChartProps {
  historicalData: any[];
  devices: any[];
}

export default function PowerChart({ historicalData, devices }: PowerChartProps) {
  const chartRef = useRef<any>(null);
  const timePointsRef = useRef<Date[]>([]);

  // Get the most recent timestamp from historical data or use current time
  const latestTimestamp = historicalData.length > 0 
    ? new Date(historicalData[historicalData.length - 1].timestamp)
    : new Date();
  
  // Calculate 10 minutes ago from the latest timestamp
  const tenMinutesAgo = new Date(latestTimestamp.getTime() - 10 * 60 * 1000);
  
  // Create a complete time series with 2-second intervals (matching our polling rate)
  const timeLabels: string[] = [];
  const timePoints: Date[] = [];
  for (let time = tenMinutesAgo.getTime(); time <= latestTimestamp.getTime(); time += 2000) {
    const date = new Date(time);
    timePoints.push(date);
    timeLabels.push(format(date, 'h:mm a'));
  }
  
  // Store timePoints in ref for use in callbacks
  timePointsRef.current = timePoints;
  
  // Map power update events to the complete time series
  const mapDataToTimeSeries = (serialNumber: string, getValue: (deviceData: any) => number | undefined) => {
    return timePoints.map(time => {
      const event = historicalData.find(e => 
        Math.abs(new Date(e.timestamp).getTime() - time.getTime()) < 1000  // Allow 1 second tolerance
      );
      if (event && event[serialNumber]) {
        const value = getValue(event[serialNumber]);
        return value !== undefined && value !== null ? value / 1000 : null;
      }
      return null;
    });
  };

  // Prepare chart data (convert W to kW)
  const datasets: any[] = [];
  
  // Get site-level data from power update events
  const siteLoad = timePoints.map(time => {
    const event = historicalData.find(e => 
      Math.abs(new Date(e.timestamp).getTime() - time.getTime()) < 1000
    );
    if (event?.site?.load?.powerW !== undefined && event.site.load.powerW !== null) {
      return event.site.load.powerW / 1000;
    }
    return null;
  });
  
  const siteGrid = timePoints.map(time => {
    const event = historicalData.find(e => 
      Math.abs(new Date(e.timestamp).getTime() - time.getTime()) < 1000
    );
    if (event?.site?.grid?.powerW !== undefined && event.site.grid.powerW !== null) {
      return event.site.grid.powerW / 1000;
    }
    return null;
  });
  
  const siteBattery = timePoints.map(time => {
    const event = historicalData.find(e => 
      Math.abs(new Date(e.timestamp).getTime() - time.getTime()) < 1000
    );
    if (event?.site?.battery?.powerW !== undefined && event.site.battery.powerW !== null) {
      return event.site.battery.powerW / 1000;
    }
    return null;
  });
  
  // Add datasets in order for legend: Solar, Battery, Grid, Load
  // First add solar datasets for each device
  const solarColors = ['rgba(255, 235, 59, 0.2)', 'rgba(255, 241, 118, 0.2)', 'rgba(255, 249, 196, 0.2)'];
  devices.forEach((device, index) => {
    const solarData = mapDataToTimeSeries(device.serialNumber, data => data.solar?.powerW);
    if (solarData.some(val => val !== null)) {
      datasets.push({
        label: `Solar ${device.name || device.serialNumber}`,
        data: solarData,
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
  
  // Then add site-level Battery
  if (siteBattery.some(val => val !== null)) {
    datasets.push({
      label: 'Battery',
      data: siteBattery,
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
  
  // Then add site-level Grid
  if (siteGrid.some(val => val !== null)) {
    datasets.push({
      label: 'Grid',
      data: siteGrid,
      borderColor: 'rgb(147, 51, 234)',
      backgroundColor: 'rgba(147, 51, 234, 0.1)',
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
      order: 3 // Grid third in legend
    });
  }
  
  // Finally add site-level Load
  if (siteLoad.some(val => val !== null)) {
    datasets.push({
      label: 'Load',
      data: siteLoad,
      borderColor: 'rgb(249, 115, 22)',
      backgroundColor: 'rgba(249, 115, 22, 0.1)',
      borderWidth: 2,
      tension: 0.1,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
      order: 4 // Load last in legend
    });
  }
  
  const chartData = {
    labels: timeLabels,
    datasets: datasets
  };

  const options: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 0 // Disable animations for smoother real-time updates
    },
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
          color: 'rgb(107, 114, 128)',
          maxTicksLimit: 10,
          callback: function(value, index, values) {
            const date = timePointsRef.current[index];
            if (!date) return '';
            
            // Show label at the minute mark (:00 seconds)
            if (date.getSeconds() === 0) {
              return format(date, 'h:mm');
            }
            
            // Also show labels at reasonable intervals to avoid empty axis
            if (values.length <= 10) {
              // Show all labels when few points
              return format(date, 'h:mm');
            } else if (index % 30 === 0) {
              // Show every minute when many points
              return format(date, 'h:mm');
            }
            
            return '';
          }
        },
        grid: {
          display: true,
          color: function(context) {
            if (context.index === undefined || context.index === null) return 'transparent';
            
            const date = timePointsRef.current[context.index];
            if (!date) return 'transparent';
            
            // Show grid line every minute (when seconds === 0)
            // Use a visible color for minute marks, transparent for others
            return date.getSeconds() === 0 ? 'rgba(107, 114, 128, 0.3)' : 'transparent';
          },
          drawBorder: false,
          drawTicks: false
        }
      },
      y: {
        display: true,
        position: 'left' as const,
        // Determine min based on whether there's battery data
        min: siteBattery.some(val => val !== null) ? -1 : 0,
        max: 5, // Always show at least 5kW
        title: {
          display: true,
          text: 'Power (kW)',
          color: 'rgb(156, 163, 175)',
          font: {
            family: 'DM Sans, sans-serif',
            size: 12
          }
        },
        ticks: {
          color: 'rgb(107, 114, 128)',
          stepSize: 1, // Force integer steps
          callback: function(value, index, ticks) {
            // Only show 'kW' on the top (last) label
            if (index === ticks.length - 1) {
              return value + ' kW';
            }
            // Show integer values only
            return Number.isInteger(value as number) ? value.toString() : '';
          }
        },
        grid: {
          color: 'rgba(107, 114, 128, 0.1)',
          drawBorder: false
        }
      }
    }
  };

  // Update chart when new data arrives - update data directly instead of full re-render
  useEffect(() => {
    if (chartRef.current && chartRef.current.data) {
      const chart = chartRef.current;
      
      // Update labels
      chart.data.labels = timeLabels;
      
      // Update existing datasets without replacing them
      datasets.forEach((newDataset, index) => {
        if (chart.data.datasets[index]) {
          // Update existing dataset's data only, preserving all other properties including hidden state
          chart.data.datasets[index].data = newDataset.data;
        } else {
          // Add new dataset if it doesn't exist
          chart.data.datasets.push(newDataset);
        }
      });
      
      // Remove extra datasets if needed
      while (chart.data.datasets.length > datasets.length) {
        chart.data.datasets.pop();
      }
      
      // Update without animation for smooth updates
      chart.update('none');
    }
  }, [timeLabels, datasets]);

  if (datasets.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center bg-transparent rounded-lg">
        <p className="text-gray-500">Waiting for data...</p>
      </div>
    );
  }

  return (
    <div className="h-64">
      <Line ref={chartRef} data={chartData} options={options} />
    </div>
  );
}