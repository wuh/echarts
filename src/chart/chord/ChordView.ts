/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/

import * as graphic from '../../util/graphic';
import ChartView from '../../view/Chart';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import SeriesData from '../../data/SeriesData';
import ChordSeriesModel, { ChordNodeItemOption } from './ChordSeries';
import ChordPiece from './ChordPiece';
import { ChordEdge } from './ChordEdge';
import { parsePercent } from '../../util/number';
import { getECData } from '../../util/innerStore';
import {
    LegendAvoidableSeriesView,
    LayoutLegendContext,
    calculateOuterBoundingRectWithLabels,
    calculateLabelBoundingRect
} from '../../util/autoLayout';
import BoundingRect from 'zrender/lib/core/BoundingRect';
import { getCircleLayout } from '../../util/layout';
import SeriesModel from '../../model/Series';
import { CircleLayoutOptionMixin, SeriesOption } from '../../util/types';
import { chordLayout } from './chordLayout';

const RADIAN = Math.PI / 180;

class ChordView extends ChartView implements LegendAvoidableSeriesView {

    static readonly type = 'chord';
    readonly type: string = ChordView.type;

    private _data: SeriesData;
    private _edgeData: SeriesData;

    /** @implements LegendAvoidableSeriesView */
    autoLayoutContext: LayoutLegendContext | undefined;

    init(ecModel: GlobalModel, api: ExtensionAPI) {
    }

    render(seriesModel: ChordSeriesModel, ecModel: GlobalModel, api: ExtensionAPI) {
        // 处理自动布局上下文中的边距压缩
        const margin = this.autoLayoutContext?.margin;
        if (margin != null) {
            // 使用布局函数应用margin压缩
            chordLayout(seriesModel, api, margin);
        }
        const data = seriesModel.getData();
        const oldData = this._data;
        const group = this.group;

        const startAngle = -seriesModel.get('startAngle') * RADIAN;

        data.diff(oldData)
            .add((newIdx) => {
                /* Consider the case when there are only two nodes A and B,
                 * and there is a link between A and B.
                 * At first, they are both disselected from legend. And then
                 * when A is selected, A will go into `add` method. But since
                 * there are no edges to be displayed, A should not be added.
                 * So we should only add A when layout is defined.
                 */

                const layout = data.getItemLayout(newIdx);
                if (layout) {
                    const el = new ChordPiece(data, newIdx, startAngle);
                    getECData(el).dataIndex = newIdx;
                    group.add(el);
                }
            })

            .update((newIdx, oldIdx) => {
                let el = oldData.getItemGraphicEl(oldIdx) as ChordPiece;
                const layout = data.getItemLayout(newIdx);

                /* Consider the case when there are only two nodes A and B,
                 * and there is a link between A and B.
                 * and when A is disselected from legend, there should be
                 * nothing to display. But in the `data.diff` method, B will go
                 * into `update` method and having no layout.
                 * In this case, we need to remove B.
                 */
                if (!layout) {
                    el && graphic.removeElementWithFadeOut(el, seriesModel, oldIdx);
                    return;
                }

                if (!el) {
                    el = new ChordPiece(data, newIdx, startAngle);
                }
                else {
                    el.updateData(data, newIdx, startAngle);
                }
                group.add(el);
            })

            .remove(oldIdx => {
                const el = oldData.getItemGraphicEl(oldIdx) as ChordPiece;
                el && graphic.removeElementWithFadeOut(el, seriesModel, oldIdx);
            })

            .execute();

        if (!oldData) {
            const center = seriesModel.get('center');
            this.group.scaleX = 0.01;
            this.group.scaleY = 0.01;
            this.group.originX = parsePercent(center[0], api.getWidth());
            this.group.originY = parsePercent(center[1], api.getHeight());
            graphic.initProps(this.group, {
                scaleX: 1,
                scaleY: 1
            }, seriesModel);
        }

        this._data = data;

        this.renderEdges(seriesModel, startAngle);
    }

    renderEdges(seriesModel: ChordSeriesModel, startAngle: number) {
        const nodeData = seriesModel.getData();
        const edgeData = seriesModel.getEdgeData();
        const oldData = this._edgeData;
        const group = this.group;

        edgeData.diff(oldData)
            .add(function (newIdx) {
                const el = new ChordEdge(nodeData, edgeData, newIdx, startAngle);
                getECData(el).dataIndex = newIdx;
                group.add(el);
            })

            .update(function (newIdx, oldIdx) {
                const el = oldData.getItemGraphicEl(oldIdx) as ChordEdge;
                el.updateData(nodeData, edgeData, newIdx, startAngle);
                group.add(el);
            })

            .remove(function (oldIdx) {
                const el = oldData.getItemGraphicEl(oldIdx) as ChordEdge;
                el && graphic.removeElementWithFadeOut(el, seriesModel, oldIdx);
            })

            .execute();

        this._edgeData = edgeData;
    }

    /** @implements LegendAvoidableSeriesView */
    getOuterBoundingRect(
        seriesModel: ChordSeriesModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: any
    ): BoundingRect {
        // 计算和弦布局的圆心(cx, cy)和半径(r)，此布局决定了所有节点与边的分布
        const { cx, cy, r } = getCircleLayout(
            seriesModel as unknown as SeriesModel<CircleLayoutOptionMixin & SeriesOption<unknown>>,
            api
        );
        // chordRect 是和弦主区域的圆形的外接矩形，是基础的可视区域判断边界
        const chordRect = new BoundingRect(cx - r, cy - r, r * 2, r * 2);

        // 获取系列数据，准备收集全部可见节点标签的边界信息
        const data = seriesModel.getData();
        // 存放所有节点标签的矩形边界信息，用于后续整体合并
        const labelLayouts: Array<{ rect: BoundingRect; textAlign?: string }> = [];

        // 遍历每一个节点，收集其标签的实际像素边界矩形
        data.each(function (idx) {
            // 取出当前下标的节点对象
            const node = data.graph.getNodeByIndex(idx);
            const layout = node.getLayout();
            // 若当前节点未参与布局（如被过滤），直接跳过
            if (!layout) {
                return;
            }
            // 节点级的模型，包括label等配置信息
            const itemModel = node.getModel<ChordNodeItemOption>();
            const labelModel = itemModel.getModel('label');
            // 若配置中本节点的标签未开启显示，则不参与外边界计算
            if (!labelModel.get('show')) {
                return;
            }
            // 只考虑标签配置为显示在圆外侧的情况，内侧标签不会溢出主圆不计入外边界
            const labelPosition = labelModel.get('position') || 'outside';
            if (labelPosition !== 'outside') {
                return;
            }
            // 用系列的格式化方式获取标签文本，若无格式化则使用节点名
            let labelText = seriesModel.getFormattedLabel(idx, 'normal');
            if (labelText == null) {
                labelText = data.getName(idx);
            }
            // 根据当前节点的扇形角度区间，计算此标签对应的中心角度
            const midAngle = (layout.startAngle + layout.endAngle) / 2;
            // 根据角度求标签参考点的单位向量
            const dx = Math.cos(midAngle);
            const dy = Math.sin(midAngle);

            // 标签与圆环的距离偏移（可通过label.distance配置）
            const labelPadding = labelModel.get('distance') || 0;
            // 标签参考径向距离 = 节点弧半径 + 配置的外移距离
            const labelRadius = layout.r + labelPadding;

            // 计算标签参考点的坐标（极坐标转直角坐标）
            const labelX = dx * labelRadius + layout.cx;
            const labelY = dy * labelRadius + layout.cy;

            // 水平对齐与垂直对齐方向，保证外侧标签在视觉上靠外侧
            const align = dx > 0 ? 'left' : 'right';
            const verticalAlign = dy > 0 ? 'top' : 'bottom';

            // 使用通用文本包围盒工具，得到文本的像素边界矩形
            // 传入文字内容、坐标、对齐方式以及文本相关样式信息
            const labelRect = calculateLabelBoundingRect({
                align,
                verticalAlign,
                text: labelText || '',
                x: labelX,
                y: labelY,
                rotation: 0,  // 和弦图标签一般不旋转
                originX: labelX,
                originY: labelY
            }, itemModel);

            // 收集合法的标签像素矩形，为后续整体包络计算做准备
            labelLayouts.push({
                rect: labelRect
            });
        });

        // 计算主圆和所有标签组成的总边界，作为该 SeriesView 的外包络
        return calculateOuterBoundingRectWithLabels(chordRect, labelLayouts);
    }

    dispose() {

    }
}


export default ChordView;
