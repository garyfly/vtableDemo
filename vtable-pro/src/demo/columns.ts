/**
 * 演示用的列定义。
 *
 * 「不同列使用导入的自定义组件」在这里就是 `cell: { component }`：
 * 负责人 / 状态 / 进度 / 标签 / 操作 五列各自导入一个 SFC，
 * 其余列（单号、客户、金额、城市、时间…）留在 canvas 文本快路径上。
 * 两边的渲染成本差一个数量级，所以能不能只让需要的列付这笔钱，是这张表的重点。
 */

import type { ProColumn } from '../lib';
import { formatMoney, type OrderRow } from './data';
import ActionsCell from './cells/ActionsCell.vue';
import OwnerCell from './cells/OwnerCell.vue';
import ProgressCell from './cells/ProgressCell.vue';
import StatusCell from './cells/StatusCell.vue';
import TagsCell from './cells/TagsCell.vue';

const PRIORITY_COLOR: Record<string, string> = { 低: '#86909C', 中: '#165DFF', 高: '#FF7D00', 紧急: '#F53F3F' };

export function makeColumns(onAction: (payload: { action: 'view' | 'edit'; row: Record<string, any> }) => void): ProColumn[] {
  return [
    { field: 'orderNo', title: '订单号', width: 150, filterKind: 'text' },
    { field: 'customer', title: '客户', width: 220, filterKind: 'text', maxWidth: 320 },
    {
      field: 'owner',
      title: '负责人',
      width: 150,
      filterKind: 'options',
      cell: { component: OwnerCell },
    },
    {
      field: 'status',
      title: '状态',
      width: 124,
      filterKind: 'options',
      cell: { component: StatusCell },
    },
    {
      field: 'priority',
      title: '优先级',
      width: 104,
      filterKind: 'options',
      cellStyle: ctx => ({ color: PRIORITY_COLOR[String(ctx.row.priority)] ?? '#1D2129', fontWeight: 600 }),
    },
    { field: 'city', title: '城市', width: 116, filterKind: 'options' },
    { field: 'channel', title: '来源', width: 116, filterKind: 'options' },
    { field: 'industry', title: '行业', width: 116, filterKind: 'options' },
    {
      field: 'amount',
      title: '金额',
      width: 140,
      align: 'right',
      filterKind: 'text',
      format: formatMoney,
    },
    {
      field: 'progress',
      title: '进度',
      width: 170,
      filterable: false,
      cell: { component: ProgressCell },
    },
    {
      field: 'tags',
      title: '标签',
      width: 190,
      filterable: false,
      sortable: false,
      cell: { component: TagsCell },
    },
    { field: 'updatedAt', title: '更新时间', width: 150, filterKind: 'text' },
    {
      field: 'actions',
      title: '操作',
      width: 140,
      sortable: false,
      filterable: false,
      cell: {
        component: ActionsCell,
        // 这一列有按钮，必须打开指针事件（覆盖层默认是穿透的）
        interactive: true,
        props: () => ({ onAction }),
      },
    },
  ];
}

export type { OrderRow };
