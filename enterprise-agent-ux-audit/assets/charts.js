(function () {
  'use strict';

  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var accent3 = style.getPropertyValue('--accent3').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var muted2 = style.getPropertyValue('--muted2').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var bg3 = style.getPropertyValue('--bg3').trim();
  var danger = style.getPropertyValue('--danger').trim();

  // ---- Chart 1: AI Negative Events Pain Points ----
  var painEl = document.getElementById('chart-painpoints');
  if (painEl) {
    var painChart = echarts.init(painEl, null, { renderer: 'svg' });
    painChart.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: bg3,
        borderColor: rule,
        textStyle: { color: ink, fontSize: 13 },
        appendToBody: true
      },
      grid: { left: '28%', right: '8%', top: 20, bottom: 20 },
      xAxis: {
        type: 'value',
        max: 35,
        axisLabel: { color: muted, fontSize: 11, formatter: '{value}%' },
        axisLine: { lineStyle: { color: rule } },
        splitLine: { lineStyle: { color: rule, type: 'dashed' } }
      },
      yAxis: {
        type: 'category',
        data: ['不准确性/幻觉', '可解释性不足', '个人隐私', '网络安全', '知识产权', '合规风险', '其他'],
        axisLabel: { color: ink, fontSize: 12 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      series: [{
        type: 'bar',
        data: [
          { value: 30, itemStyle: { color: danger } },
          { value: 14, itemStyle: { color: accent2 } },
          { value: 11, itemStyle: { color: accent2 } },
          { value: 10, itemStyle: { color: accent2 } },
          { value: 8, itemStyle: { color: accent } },
          { value: 7, itemStyle: { color: accent } },
          { value: 20, itemStyle: { color: accent } }
        ],
        barWidth: '55%',
        label: {
          show: true,
          position: 'right',
          color: ink,
          fontSize: 12,
          fontWeight: 600,
          formatter: '{c}%'
        }
      }]
    });
    window.addEventListener('resize', function () { painChart.resize(); });
  }

  // ---- Chart 2: Adoption Funnel ----
  var adoptEl = document.getElementById('chart-adoption');
  if (adoptEl) {
    var adoptChart = echarts.init(adoptEl, null, { renderer: 'svg' });
    adoptChart.setOption({
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: bg3,
        borderColor: rule,
        textStyle: { color: ink, fontSize: 13 },
        appendToBody: true,
        formatter: function (params) {
          return params[0].name + '<br/>占比: ' + params[0].value + '%';
        }
      },
      grid: { left: '10%', right: '10%', top: 30, bottom: 30 },
      xAxis: {
        type: 'category',
        data: ['AI 常态化使用', 'Agent 在用\n(含试验)', '企业级规模化', '深度集成'],
        axisLabel: { color: ink, fontSize: 11, interval: 0 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        max: 100,
        axisLabel: { color: muted, fontSize: 11, formatter: '{value}%' },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: rule, type: 'dashed' } }
      },
      series: [{
        type: 'bar',
        data: [
          { value: 88, itemStyle: { color: accent3 } },
          { value: 62, itemStyle: { color: accent } },
          { value: 31, itemStyle: { color: accent2 } },
          { value: 5, itemStyle: { color: danger } }
        ],
        barWidth: '50%',
        label: {
          show: true,
          position: 'top',
          color: ink,
          fontSize: 14,
          fontWeight: 700,
          formatter: '{c}%'
        },
        itemStyle: {
          borderRadius: [4, 4, 0, 0]
        }
      }]
    });
    window.addEventListener('resize', function () { adoptChart.resize(); });
  }

  // ---- Chart 3: Commander UX Capability Radar ----
  var radarEl = document.getElementById('chart-radar');
  if (radarEl) {
    var radarChart = echarts.init(radarEl, null, { renderer: 'svg' });
    radarChart.setOption({
      animation: false,
      tooltip: {
        backgroundColor: bg3,
        borderColor: rule,
        textStyle: { color: ink, fontSize: 13 },
        appendToBody: true
      },
      legend: {
        data: ['Core 层实现', 'Web 前端呈现'],
        textStyle: { color: ink, fontSize: 12 },
        bottom: 0,
        itemGap: 20
      },
      radar: {
        indicator: [
          { name: '交互模式', max: 100 },
          { name: '可观测性', max: 100 },
          { name: '审批与控制', max: 100 },
          { name: '错误恢复', max: 100 },
          { name: '多 Agent 协作', max: 100 },
          { name: '安全与信任', max: 100 },
          { name: 'Web 前端体验', max: 100 }
        ],
        center: ['50%', '48%'],
        radius: '62%',
        axisName: { color: ink, fontSize: 12 },
        splitLine: { lineStyle: { color: rule } },
        splitArea: {
          areaStyle: {
            color: [bg2, 'transparent']
          }
        },
        axisLine: { lineStyle: { color: rule } }
      },
      series: [{
        type: 'radar',
        data: [
          {
            value: [75, 92, 88, 93, 90, 88, 45],
            name: 'Core 层实现',
            itemStyle: { color: accent },
            lineStyle: { color: accent, width: 2 },
            areaStyle: { color: accent, opacity: 0.15 }
          },
          {
            value: [60, 70, 75, 55, 65, 30, 50],
            name: 'Web 前端呈现',
            itemStyle: { color: accent2 },
            lineStyle: { color: accent2, width: 2 },
            areaStyle: { color: accent2, opacity: 0.12 }
          }
        ]
      }]
    });
    window.addEventListener('resize', function () { radarChart.resize(); });
  }

  // ---- Chart 4: Gap Analysis Heatmap ----
  var heatEl = document.getElementById('chart-heatmap');
  if (heatEl) {
    var heatChart = echarts.init(heatEl, null, { renderer: 'svg' });
    var xData = ['Core 实现', 'Web 呈现', '示例文档', 'API 开放'];
    var yData = [
      '前端数据断点',
      '对话式交互',
      '步级纠正',
      '幻觉风险展示',
      'Lineage 可视化',
      '审批配置统一',
      'DLQ 前端入口',
      '场景示例'
    ];
    // Gap values: 0 = no gap (fully provided), 3 = large gap
    var heatData = [
      [0, 0, 3], [1, 0, 3], [2, 0, 2], [3, 0, 2],
      [0, 1, 3], [1, 1, 3], [2, 1, 1], [3, 1, 1],
      [0, 2, 2], [1, 2, 3], [2, 2, 2], [3, 2, 1],
      [0, 3, 1], [1, 3, 3], [2, 3, 1], [3, 3, 1],
      [0, 4, 1], [1, 4, 2], [2, 4, 2], [3, 4, 1],
      [0, 5, 1], [1, 5, 2], [2, 5, 2], [3, 5, 1],
      [0, 6, 1], [1, 6, 2], [2, 6, 1], [3, 6, 1],
      [0, 7, 1], [1, 7, 1], [2, 7, 3], [3, 7, 2]
    ];

    heatChart.setOption({
      animation: false,
      tooltip: {
        backgroundColor: bg3,
        borderColor: rule,
        textStyle: { color: ink, fontSize: 13 },
        appendToBody: true,
        formatter: function (p) {
          var labels = ['无缺口', '轻微缺口', '中等缺口', '严重缺口'];
          return yData[p.value[1]] + ' × ' + xData[p.value[0]] + '<br/>缺口程度: ' + labels[p.value[2]];
        }
      },
      grid: { left: '22%', right: '12%', top: 20, bottom: 60 },
      xAxis: {
        type: 'category',
        data: xData,
        splitArea: { show: false },
        axisLabel: { color: ink, fontSize: 12 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'category',
        data: yData,
        splitArea: { show: false },
        axisLabel: { color: ink, fontSize: 11 },
        axisLine: { lineStyle: { color: rule } },
        axisTick: { show: false }
      },
      visualMap: {
        min: 0,
        max: 3,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 5,
        textStyle: { color: muted, fontSize: 11 },
        inRange: {
          color: [accent3, accent2, '#f97316', danger]
        },
        text: ['严重缺口', '无缺口']
      },
      series: [{
        type: 'heatmap',
        data: heatData,
        label: {
          show: true,
          color: '#0b1120',
          fontSize: 11,
          fontWeight: 700,
          formatter: function (p) {
            var icons = ['OK', '!', '!!', '!!!'];
            return icons[p.value[2]];
          }
        },
        itemStyle: {
          borderColor: bg2,
          borderWidth: 2,
          borderRadius: 3
        },
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowColor: 'rgba(0,0,0,0.5)'
          }
        }
      }]
    });
    window.addEventListener('resize', function () { heatChart.resize(); });
  }

  // ---- Mermaid Init ----
  if (typeof mermaid !== 'undefined') {
    mermaid.initialize({
      startOnLoad: true,
      theme: 'base',
      themeVariables: {
        primaryColor: bg3,
        primaryTextColor: ink,
        primaryBorderColor: accent,
        lineColor: accent,
        secondaryColor: bg2,
        tertiaryColor: bg2,
        fontSize: '14px',
        fontFamily: 'InstrumentSans, PingFang SC, sans-serif'
      },
      securityLevel: 'loose',
      flowchart: {
        curve: 'basis',
        padding: 20,
        nodeSpacing: 40,
        rankSpacing: 50
      }
    });
  }
})();
