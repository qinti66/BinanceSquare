import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType } from 'lightweight-charts';
import { ArrowClockwise, ImageSquare, WarningCircle, X } from '@phosphor-icons/react';
import './chart.css';

const PERIODS = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };
const PERIOD_LABELS = { '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '1h': '1小时', '4h': '4小时', '1d': '1天', '1w': '1周' };
const pairLabel = symbol => symbol.replace(/(USDT|USDC|BTC|ETH)$/, '/$1');

function makeDemoData(symbol, interval) {
  const base = symbol.startsWith('ETH') ? 3200 : symbol.startsWith('BNB') ? 640 : symbol.startsWith('SOL') ? 155 : symbol.startsWith('XRP') ? 2.8 : symbol.startsWith('DOGE') ? 0.22 : 120500;
  const step = PERIODS[interval] || 14400;
  const end = Math.floor(Date.UTC(2026, 8, 18, 8) / 1000 / step) * step;
  // Deterministic illustrative shape: early rise, central pullback, late recovery.
  const anchors = [[0, 0], [7, 0.017], [17, -0.012], [23, -0.010], [29, -0.030], [35, -0.021], [44, -0.007], [48, 0.001], [51, -0.013], [57, 0.013], [61, 0.035], [63, 0.028]];
  let previous = base;
  return Array.from({ length: 64 }, (_, i) => {
    const right = anchors.findIndex(point => point[0] >= i);
    const [startIndex, start] = anchors[Math.max(0, right - 1)];
    const [endIndex, endValue] = anchors[Math.max(0, right)];
    const progress = endIndex === startIndex ? 0 : (i - startIndex) / (endIndex - startIndex);
    const trend = start + (endValue - start) * progress;
    const open = previous;
    const close = base * (1 + trend + Math.sin(i * 2.23) * 0.0021 + Math.sin(i * 0.92) * 0.0011);
    const spread = (0.001 + (1 + Math.sin(i * 2.37)) * 0.0006) * base;
    const volume = Math.round(130 + Math.abs(close - open) / base * 85000 + (1 + Math.sin(i * 1.7)) * 90);
    previous = close;
    return { time: end - (63 - i) * step, open, high: Math.max(open, close) + spread, low: Math.min(open, close) - spread * 0.8, close, volume };
  });
}

export function CandleChart({ symbol = 'BTCUSDT', interval = '4h', demo = true, onImage, onRemove }) {
  const container = useRef(null);
  const onImageRef = useRef(onImage);
  onImageRef.current = onImage;
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const normalizedSymbol = String(symbol).replace(/\W/g, '').toUpperCase();
  const displayPair = pairLabel(normalizedSymbol);
  const periodLabel = PERIOD_LABELS[interval] || interval;

  useEffect(() => {
    if (!container.current) return undefined;
    let alive = true;
    let ready = false;
    let screenshotTimer;
    let screenshotVersion = 0;
    let timeout;
    let candleTime = '';
    const controller = new AbortController();
    setStatus('loading');
    setError('');
    onImageRef.current?.(null);
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#14171c' }, textColor: '#727986', fontSize: 10, fontFamily: 'Inter, "Microsoft YaHei", sans-serif', attributionLogo: true },
      grid: { vertLines: { color: '#20242b' }, horzLines: { color: '#20242b' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 2 },
      crosshair: { vertLine: { color: '#596170', labelBackgroundColor: '#303743' }, horzLine: { color: '#596170', labelBackgroundColor: '#303743' } },
      localization: { locale: 'zh-CN' },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#21a584', downColor: '#ef6464', wickUpColor: '#21a584', wickDownColor: '#ef6464', borderVisible: false, priceLineColor: '#21a584', priceLineWidth: 1, priceFormat: { type: 'price', precision: /^(XRP|DOGE)/.test(normalizedSymbol) ? 4 : 2, minMove: /^(XRP|DOGE)/.test(normalizedSymbol) ? 0.0001 : 0.01 } });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, borderVisible: false });

    function exportImage() {
      if (!alive || !ready) return;
      const version = ++screenshotVersion;
      try {
        const plot = chart.takeScreenshot();
        const scale = window.devicePixelRatio || 1;
        const header = Math.round(38 * scale);
        const footer = Math.round(28 * scale);
        const output = document.createElement('canvas');
        output.width = plot.width;
        output.height = plot.height + header + footer;
        const ctx = output.getContext('2d');
        if (!ctx || !output.width) throw new Error('图表尺寸尚未就绪');
        ctx.fillStyle = '#14171c';
        ctx.fillRect(0, 0, output.width, output.height);
        ctx.drawImage(plot, 0, header);
        ctx.fillStyle = '#e6e8ee';
        ctx.font = `600 ${12 * scale}px "Microsoft YaHei", sans-serif`;
        ctx.fillText(`${displayPair} · ${periodLabel}`, 14 * scale, 24 * scale);
        ctx.fillStyle = demo ? '#f0b90b' : '#21a584';
        ctx.textAlign = 'right';
        ctx.font = `${10 * scale}px "Microsoft YaHei", sans-serif`;
        ctx.fillText(demo ? '示例图表 · 非实时行情' : 'Binance 公开行情', output.width - 14 * scale, 24 * scale);
        ctx.fillStyle = '#858e9c';
        ctx.textAlign = 'left';
        ctx.fillText(`${demo ? '模拟数据' : '行情快照'} · ${candleTime} UTC`, 14 * scale, output.height - 10 * scale);
        output.toBlob(blob => {
          if (alive && ready && version === screenshotVersion) onImageRef.current?.(blob);
        }, 'image/png');
      } catch (cause) {
        onImageRef.current?.(null);
        setError(`图表图片生成失败：${cause.message}`);
      }
    }

    function scheduleImage() {
      clearTimeout(screenshotTimer);
      screenshotTimer = setTimeout(exportImage, 160);
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleImage);
    const observer = new ResizeObserver(scheduleImage);
    observer.observe(container.current);

    async function load() {
      try {
        let data;
        if (demo) {
          data = makeDemoData(normalizedSymbol, interval);
        } else {
          timeout = setTimeout(() => controller.abort(), 15000);
          const query = new URLSearchParams({ symbol: normalizedSymbol, interval, limit: '120' });
          const response = await fetch(`https://api.binance.com/api/v3/klines?${query}`, { signal: controller.signal });
          const result = await response.json().catch(() => null);
          if (!response.ok) throw new Error(result?.msg || `行情接口返回 ${response.status}`);
          if (!Array.isArray(result) || !result.length) throw new Error('行情接口没有返回 K 线数据');
          data = result.map(row => ({ time: Math.floor(Number(row[0]) / 1000), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) }));
          if (data.some(item => Object.values(item).some(value => !Number.isFinite(value)))) throw new Error('行情数据格式无效');
        }
        if (!alive) return;
        candles.setData(data.map(({ volume: ignored, ...candle }) => candle));
        volume.setData(data.map(candle => ({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? '#21a58470' : '#ef646470' })));
        chart.timeScale().fitContent();
        const last = data.at(-1);
        candleTime = new Date(last.time * 1000).toISOString().slice(0, 16).replace('T', ' ');
        ready = true;
        setStatus('ready');
        scheduleImage();
      } catch (cause) {
        if (!alive) return;
        ready = false;
        onImageRef.current?.(null);
        setStatus('error');
        setError(cause.name === 'AbortError' ? '获取行情超时，请检查网络后重试' : `无法获取行情：${cause.message}`);
      } finally {
        clearTimeout(timeout);
      }
    }
    load();
    return () => {
      alive = false;
      ready = false;
      controller.abort();
      clearTimeout(timeout);
      clearTimeout(screenshotTimer);
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(scheduleImage);
      chart.remove();
      onImageRef.current?.(null);
    };
  }, [normalizedSymbol, interval, demo, refresh, displayPair, periodLabel]);

  return <section className="chart-card" aria-label={`${displayPair} ${periodLabel} K线图`}>
    <div className="chart-header">
      <div className="chart-heading"><span className="chart-pair">{displayPair}</span><span className="chart-period">· {periodLabel}</span><span className={`chart-mode ${demo ? 'chart-demo' : ''}`}>{demo ? '示例图表' : '实时数据'}</span></div>
      <div className="chart-actions"><button type="button" className="chart-icon" onClick={() => setRefresh(value => value + 1)} aria-label="刷新K线" title="刷新K线" disabled={status === 'loading'}><ArrowClockwise size={15} /></button>{onRemove && <button type="button" className="chart-icon" onClick={onRemove} aria-label="移除K线" title="移除K线"><X size={15} /></button>}</div>
    </div>
    <div className="chart-stage"><div ref={container} className="chart-canvas" />{status === 'loading' && <div className="chart-error" role="status">正在加载图表…</div>}{status === 'error' && <div className="chart-error" role="alert"><WarningCircle size={24} /><span>{error}</span><button type="button" onClick={() => setRefresh(value => value + 1)}>重新获取行情</button></div>}</div>
    <div className="chart-footer"><span><ImageSquare size={13} />以图片形式发布</span><span>{demo ? '示例数据 · 2026-09-18' : 'Binance 行情 · 手动刷新'}</span></div>
    {error && status !== 'error' && <div className="chart-export-error" role="alert">{error}</div>}
  </section>;
}

export default CandleChart;



