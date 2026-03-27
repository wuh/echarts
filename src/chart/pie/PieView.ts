
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


import { clone, extend, retrieve3 } from 'zrender/src/core/util';
import * as graphic from '../../util/graphic';
import { setStatesStylesFromModel, toggleHoverEmphasis } from '../../util/states';
import ChartView from '../../view/Chart';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import { Payload, ColorString } from '../../util/types';
import SeriesData from '../../data/SeriesData';
import PieSeriesModel, { PieDataItemOption } from './PieSeries';
import labelLayout from './labelLayout';
import { setLabelLineStyle, getLabelLineStatesModels } from '../../label/labelGuideHelper';
import { setLabelStyle, getLabelStatesModels } from '../../label/labelStyle';
import { getSectorCornerRadius } from '../helper/sectorHelper';
import { saveOldStyle } from '../../animation/basicTransition';
import { getSeriesLayoutData, pieSingleLayout } from './pieLayout';
import {
    LegendAvoidableSeriesView,
    LayoutLegendContext,
    calculateOuterBoundingRectWithLabels,
    calculateCircularBoundingRect
} from '../../util/autoLayout';
import { BoundingRect } from 'zrender';
import { getCircleLayout } from '../../util/layout';


/**
 * Piece of pie including Sector, Label, LabelLine
 */
class PiePiece extends graphic.Sector {

    constructor(data: SeriesData, idx: number, startAngle: number) {
        super();

        this.z2 = 2;

        const text = new graphic.Text();

        this.setTextContent(text);

        this.updateData(data, idx, startAngle, true);
    }

    updateData(data: SeriesData, idx: number, startAngle?: number, firstCreate?: boolean): void {
        const sector = this;

        const seriesModel = data.hostModel as PieSeriesModel;
        const itemModel = data.getItemModel<PieDataItemOption>(idx);
        const emphasisModel = itemModel.getModel('emphasis');
        const layout = data.getItemLayout(idx) as graphic.Sector['shape'];
        // cornerRadius & innerCornerRadius doesn't exist in the item layout. Use `0` if null value is specified.
        // see `setItemLayout` in `pieLayout.ts`.
        const sectorShape = extend(
            getSectorCornerRadius(itemModel.getModel('itemStyle'), layout, true),
            layout
        );

        // Ignore NaN data.
        if (isNaN(sectorShape.startAngle)) {
            // Use NaN shape to avoid drawing shape.
            sector.setShape(sectorShape);
            return;
        }

        if (firstCreate) {
            sector.setShape(sectorShape);

            const animationType = seriesModel.getShallow('animationType');
            if (seriesModel.ecModel.ssr) {
                // Use scale animation in SSR mode(opacity?)
                // Because CSS SVG animation doesn't support very customized shape animation.
                graphic.initProps(sector, {
                    scaleX: 0,
                    scaleY: 0
                }, seriesModel, { dataIndex: idx, isFrom: true });
                sector.originX = sectorShape.cx;
                sector.originY = sectorShape.cy;
            }
            else if (animationType === 'scale') {
                sector.shape.r = layout.r0;
                graphic.initProps(sector, {
                    shape: {
                        r: layout.r
                    }
                }, seriesModel, idx);
            }
            // Expansion
            else {
                if (startAngle != null) {
                    sector.setShape({ startAngle, endAngle: startAngle });
                    graphic.initProps(sector, {
                        shape: {
                            startAngle: layout.startAngle,
                            endAngle: layout.endAngle
                        }
                    }, seriesModel, idx);
                }
                else {
                    sector.shape.endAngle = layout.startAngle;
                    graphic.updateProps(sector, {
                        shape: {
                            endAngle: layout.endAngle
                        }
                    }, seriesModel, idx);
                }
            }
        }
        else {
            saveOldStyle(sector);
            // Transition animation from the old shape
            graphic.updateProps(sector, {
                shape: sectorShape
            }, seriesModel, idx);
        }

        sector.useStyle(data.getItemVisual(idx, 'style'));

        setStatesStylesFromModel(sector, itemModel);

        const midAngle = (layout.startAngle + layout.endAngle) / 2;
        const offset = seriesModel.get('selectedOffset');
        const dx = Math.cos(midAngle) * offset;
        const dy = Math.sin(midAngle) * offset;

        const cursorStyle = itemModel.getShallow('cursor');
        cursorStyle && sector.attr('cursor', cursorStyle);

        this._updateLabel(seriesModel, data, idx);

        sector.ensureState('emphasis').shape = extend({
            r: layout.r + (emphasisModel.get('scale')
                ? (emphasisModel.get('scaleSize') || 0) : 0)
        }, getSectorCornerRadius(emphasisModel.getModel('itemStyle'), layout));
        extend(sector.ensureState('select'), {
            x: dx,
            y: dy,
            shape: getSectorCornerRadius(itemModel.getModel(['select', 'itemStyle']), layout)
        });
        extend(sector.ensureState('blur'), {
            shape: getSectorCornerRadius(itemModel.getModel(['blur', 'itemStyle']), layout)
        });

        const labelLine = sector.getTextGuideLine();
        const labelText = sector.getTextContent();

        labelLine && extend(labelLine.ensureState('select'), {
            x: dx,
            y: dy
        });
        // TODO: needs dx, dy in zrender?
        extend(labelText.ensureState('select'), {
            x: dx,
            y: dy
        });

        toggleHoverEmphasis(
            this, emphasisModel.get('focus'), emphasisModel.get('blurScope'), emphasisModel.get('disabled')
        );
    }

    private _updateLabel(seriesModel: PieSeriesModel, data: SeriesData, idx: number): void {
        const sector = this;
        const itemModel = data.getItemModel<PieDataItemOption>(idx);
        const labelLineModel = itemModel.getModel('labelLine');

        const style = data.getItemVisual(idx, 'style');
        const visualColor = style && style.fill as ColorString;
        const visualOpacity = style && style.opacity;

        setLabelStyle(
            sector,
            getLabelStatesModels(itemModel),
            {
                labelFetcher: data.hostModel as PieSeriesModel,
                labelDataIndex: idx,
                inheritColor: visualColor,
                defaultOpacity: visualOpacity,
                defaultText: seriesModel.getFormattedLabel(idx, 'normal')
                    || data.getName(idx)
            }
        );
        const labelText = sector.getTextContent();

        // Set textConfig on sector.
        sector.setTextConfig({
            // reset position, rotation
            position: null,
            rotation: null,
        });

        // Make sure update style on labelText after setLabelStyle.
        // Because setLabelStyle will replace a new style on it.
        labelText.attr({
            z2: 10
        });

        const labelPosition = itemModel.get(['label', 'position']);
        if (labelPosition !== 'outside' && labelPosition !== 'outer') {
            sector.removeTextGuideLine();
        }
        else {
            let polyline = this.getTextGuideLine();
            if (!polyline) {
                polyline = new graphic.Polyline();
                this.setTextGuideLine(polyline);
            }

            // Default use item visual color
            setLabelLineStyle(this, getLabelLineStatesModels(itemModel), {
                stroke: visualColor,
                opacity: retrieve3(labelLineModel.get(['lineStyle', 'opacity']), visualOpacity, 1)
            });
        }
    }
}


// Pie view
class PieView extends ChartView implements LegendAvoidableSeriesView {
    /** @implements LegendAvoidableSeriesView */
    autoLayoutContext: LayoutLegendContext;

    static type = 'pie';

    ignoreLabelLineUpdate = true;

    private _data: SeriesData;
    private _emptyCircleSector: graphic.Sector;

    render(seriesModel: PieSeriesModel, ecModel: GlobalModel, api: ExtensionAPI, payload: Payload): void {
        const data = seriesModel.getData();

        const margin = this.autoLayoutContext?.margin;
        if (margin != null) {
            // 使用布局函数应用margin压缩
            pieSingleLayout(seriesModel, api, margin);
        }

        const oldData = this._data;
        const group = this.group;

        let startAngle: number;
        // First render
        if (!oldData && data.count() > 0) {
            let shape = data.getItemLayout(0) as graphic.Sector['shape'];
            for (let s = 1; isNaN(shape && shape.startAngle) && s < data.count(); ++s) {
                shape = data.getItemLayout(s);
            }
            if (shape) {
                startAngle = shape.startAngle;
            }
        }

        // remove empty-circle if it exists
        if (this._emptyCircleSector) {
            group.remove(this._emptyCircleSector);
        }
        // when all data are filtered, show lightgray empty circle
        if (data.count() === 0 && seriesModel.get('showEmptyCircle')) {
            const layoutData = getSeriesLayoutData(seriesModel);
            const sector = new graphic.Sector({
                shape: clone(layoutData)
            });
            sector.useStyle(seriesModel.getModel('emptyCircleStyle').getItemStyle());
            this._emptyCircleSector = sector;
            group.add(sector);
        }

        data.diff(oldData)
            .add(function (idx) {
                const piePiece = new PiePiece(data, idx, startAngle);

                data.setItemGraphicEl(idx, piePiece);

                group.add(piePiece);
            })
            .update(function (newIdx, oldIdx) {
                const piePiece = oldData.getItemGraphicEl(oldIdx) as PiePiece;

                piePiece.updateData(data, newIdx, startAngle);

                piePiece.off('click');

                group.add(piePiece);
                data.setItemGraphicEl(newIdx, piePiece);
            })
            .remove(function (idx) {
                const piePiece = oldData.getItemGraphicEl(idx);
                graphic.removeElementWithFadeOut(piePiece, seriesModel, idx);
            })
            .execute();

        labelLayout(seriesModel);

        // Always use initial animation.
        if (seriesModel.get('animationTypeUpdate') !== 'expansion') {
            this._data = data;
        }
    }

    /** @implements LegendAvoidableSeriesView */
    getOuterBoundingRect(
        seriesModel: PieSeriesModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: Payload
    ): BoundingRect {
        const data = seriesModel.getData();
        // 为了正确计算饼图每个扇区的标签布局，需要在当前图形上下文中临时创建一组扇区 PiePiece 实例。
        // 这样各个标签布局才能在真实位置下准确计算，避免与真实渲染流程发生干扰。
        const tempGroup = new graphic.Group();
        // 临时 group 必须挂载到饼图主 group 下，否则部分依赖上下文的布局（如 label 旋转等）会不准确。
        this.group.add(tempGroup);

        const tempPiePieces: PiePiece[] = [];
        data.each(function (idx) {
            const layout = data.getItemLayout(idx);
            // 过滤掉未分配布局的项（如被筛选的数据），只创建有效扇区
            if (layout && !isNaN(layout.startAngle)) {
                // 这里传入的 startAngle 无实际用处，标签布局仅关心 piePiece 元素的挂载和注册
                const piePiece = new PiePiece(data, idx, null as any);
                // 挂载到临时 group，保证上下文正确
                tempGroup.add(piePiece);
                // 必须注册到数据对象，标签布局算法内部依赖此注册取到 labelGroup
                data.setItemGraphicEl(idx, piePiece);
                tempPiePieces.push(piePiece);
            }
        });

        // 此时所有 piePiece 均已临时就位，可以开始执行标签排布算法，得到标签的最终布局信息
        const labelLayoutList = labelLayout(seriesModel);

        // 标签布局已完成，务必清理现场，移除所有临时扇区，防止影响后续正常渲染
        tempPiePieces.forEach(piePiece => {
            tempGroup.remove(piePiece);
        });
        this.group.remove(tempGroup);

        // 同时清除数据上暂存的每项图形引用，确保不影响真实渲染流程
        data.each(function (idx) {
            data.setItemGraphicEl(idx, null);
        });

        // 获取当前饼图的主体圆形布局信息
        const { cx, cy, r } = getCircleLayout(seriesModel, api);
        const sectorRect = calculateCircularBoundingRect(cx, cy, r);

        // 综合主圆和所有标签外框，合成完整的外包围盒，便于图例避让等全局布局优化
        return calculateOuterBoundingRectWithLabels(sectorRect, labelLayoutList);
    }

    dispose() {}

    containPoint(point: number[], seriesModel: PieSeriesModel): boolean {
        const data = seriesModel.getData();
        const itemLayout = data.getItemLayout(0);
        if (itemLayout) {
            const dx = point[0] - itemLayout.cx;
            const dy = point[1] - itemLayout.cy;
            const radius = Math.sqrt(dx * dx + dy * dy);
            return radius <= itemLayout.r && radius >= itemLayout.r0;
        }
    }
}

export default PieView;
