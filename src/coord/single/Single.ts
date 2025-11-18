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

/**
 * Single coordinates system.
 */

import SingleAxis from './SingleAxis';
import * as axisHelper from '../axisHelper';
import { createBoxLayoutReference, getLayoutRect } from '../../util/layout';
import { each } from 'zrender/src/core/util';
import { CoordinateSystem, CoordinateSystemMaster } from '../CoordinateSystem';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import BoundingRect from 'zrender/src/core/BoundingRect';
import { RectLike } from 'zrender';
import SingleAxisModel from './AxisModel';
import SeriesModel from '../../model/Series';
import { ParsedModelFinder, ParsedModelFinderKnown } from '../../util/model';
import { ScaleDataValue, ZRRectLike } from '../../util/types';
import { AxisBaseModel } from '../AxisBaseModel';
import { CategoryAxisBaseOption } from '../axisCommonTypes';
import {
    LegendAvoidableCoordinateSystem,
    LayoutLegendContext,
    fillLegendGroupSpaceToMargin,
    collectCoordLabelSeries,
    calculateOuterBoundingRectWithLabels,
    calculateRectExpansionMargin,
    isMarginAllZero,
    calculateSeriesLabelBoundingRects,
    calculateSeriesLabelOverflowMargin,
    calculateSymbolRect
} from '../../util/autoLayout';
import AxisBuilder, { AxisBuilderSharedContext } from '../../component/axis/AxisBuilder';
import { expandOrShrinkRect } from '../../util/graphic';
import * as singleAxisHelper from './singleAxisHelper';

export const singleDimensions = ['single'];
/**
 * Create a single coordinates system.
 */
class Single implements CoordinateSystem, CoordinateSystemMaster, LegendAvoidableCoordinateSystem {

    readonly type = 'single';

    readonly dimension = 'single';
    /**
     * Add it just for draw tooltip.
     */
    readonly dimensions = singleDimensions;

    name: string;

    axisPointerEnabled: boolean = true;

    model: SingleAxisModel;

    /** @implements LegendAvoidableCoordinateSystem */
    autoLayoutContext: LayoutLegendContext | undefined;

    private _axis: SingleAxis;

    private _rect: BoundingRect;

    private _ecModel: GlobalModel;

    private _adaptiveLayout: boolean;

    constructor(axisModel: SingleAxisModel, ecModel: GlobalModel, api: ExtensionAPI) {

        this.model = axisModel;
        this._ecModel = ecModel;

        this._init(axisModel, ecModel, api);
    }

    /**
     * Initialize single coordinate system.
     */
    _init(axisModel: SingleAxisModel, ecModel: GlobalModel, api: ExtensionAPI) {

        const dim = this.dimension;

        const axis = new SingleAxis(
            dim,
            axisHelper.createScaleByModel(axisModel),
            [0, 0],
            axisModel.get('type'),
            axisModel.get('position')
        );

        const isCategory = axis.type === 'category';
        axis.onBand = isCategory && (axisModel as AxisBaseModel<CategoryAxisBaseOption>).get('boundaryGap');
        axis.inverse = axisModel.get('inverse');
        axis.orient = axisModel.get('orient');

        axisModel.axis = axis;
        axis.model = axisModel;
        axis.coordinateSystem = this;
        this._axis = axis;
    }

    /**
     * Update axis scale after data processed
     */
    update(ecModel: GlobalModel, api: ExtensionAPI) {
        ecModel.eachSeries(function (seriesModel) {
            if (seriesModel.coordinateSystem === this) {
                const data = seriesModel.getData();
                each(data.mapDimensionsAll(this.dimension), function (dim) {
                    this._axis.scale.unionExtentFromData(data, dim);
                }, this);
                axisHelper.niceScaleExtent(this._axis.scale, this._axis.model);
            }
        }, this);

        const adaptiveLayout = this._adaptiveLayout = this.model.get('adaptiveLayout');
        if (this.autoLayoutContext != null || adaptiveLayout) {
            this.resize(this.model, api);
        }
    }

    /** @implements LegendAvoidableCoordinateSystem */
    getOuterBoundingRect(): BoundingRect | null {
        return this.getRect();
    }

    /** @implements LegendAvoidableCoordinateSystem */
    applyAutoLayout(ecModel: GlobalModel, api: ExtensionAPI): void {
        this.update(ecModel, api);
    }

    /**
     * Resize the single coordinate system.
     */
    resize(axisModel: SingleAxisModel, api: ExtensionAPI) {
        const refContainer = createBoxLayoutReference(axisModel, api).refContainer;
        const rect = this._rect = getLayoutRect(axisModel.getBoxLayoutParams(), refContainer);
        this._adjustAxis();
        // 用于最终存储自动布局计算得到的边界矩形
        let finalBoundingRect: ZRRectLike;

        // 检查是否启用了自动布局上下文
        if (this.autoLayoutContext != null) {
            // needLayout 表示需要根据图例等自动调整布局
            if (this.autoLayoutContext.needLayout === true) {
                // 重新计算所有标签（如图例、轴标签等）整体的外包围框，便于后续留出足够空间
                finalBoundingRect = this._calculateLabelBoundingRect(api, refContainer);
                // 计算图例分组所占空间并自动向四周扩展 margin，确保图例不被裁剪
                fillLegendGroupSpaceToMargin(
                    this.autoLayoutContext.group,
                    api,
                    finalBoundingRect,
                    null,
                    this.autoLayoutContext
                );
            }

            // 如果已经有外部指定的 margin，则直接在主绘图区应用扩大或收缩
            if (this.autoLayoutContext.margin != null) {
                const contextMargin = this.autoLayoutContext.margin;
                // 修改主坐标系矩形（rect），以考虑配置的 margin
                expandOrShrinkRect(rect, contextMargin, true, true);
                // 若已计算出标签边界，也同步考虑 margin
                finalBoundingRect && expandOrShrinkRect(finalBoundingRect, contextMargin, true, true);
                // 扩展或收缩坐标轴时，需要同步重新调整轴的空间位置
                this._adjustAxis();
            }
        }

        // 检查是否启用自适应布局功能，包括溢出自动留白
        if (this._adaptiveLayout) {
            // 若已计算出finalBoundingRect（如自动布局已处理margin），则以此为基准，否则以参照容器为基准
            const labelRefContainer = (this.autoLayoutContext?.margin != null)
                ? finalBoundingRect
                : refContainer;

            // 计算轴标签的溢出 margin（比如标签超出了主区域），动态扩展主绘制区域rect
            const axisLabelOverflowMargin = this._calculateAxisLabelOverflowMargin(api, labelRefContainer, true);
            if (axisLabelOverflowMargin) {
                expandOrShrinkRect(rect, axisLabelOverflowMargin, true, true);
                this._adjustAxis();
            }

            // 计算数据系列标签溢出 margin，比如饼图的label或某些系列的tag超出了视觉主区域
            const seriesLabelOverflowMargin = this._calculateSeriesLabelOverflowMargin(labelRefContainer, api);
            if (seriesLabelOverflowMargin) {
                expandOrShrinkRect(rect, seriesLabelOverflowMargin, true, true);
                this._adjustAxis();
            }

            // 若 finalBoundingRect 存在，需要在自适应变形后重新评估真实的包络范围
            if (finalBoundingRect) {
                finalBoundingRect = this._calculateLabelBoundingRect(api, refContainer);
            }
        }

        // 若needLayout为true，记录最终获得的整体标签包围矩形，便于后续传递给其它布局算法
        if (this.autoLayoutContext?.needLayout === true) {
            this.autoLayoutContext.finalBoundingRect = finalBoundingRect;
        }
    }

    getRect() {
        return this._rect;
    }

    private _adjustAxis() {

        const rect = this._rect;
        const axis = this._axis;

        const isHorizontal = axis.isHorizontal();
        const extent = isHorizontal ? [0, rect.width] : [0, rect.height];
        const idx = axis.inverse ? 1 : 0;

        axis.setExtent(extent[idx], extent[1 - idx]);

        this._updateAxisTransform(axis, isHorizontal ? rect.x : rect.y);

    }


    private _updateAxisTransform(axis: SingleAxis, coordBase: number) {

        const axisExtent = axis.getExtent();
        const extentSum = axisExtent[0] + axisExtent[1];
        const isHorizontal = axis.isHorizontal();

        axis.toGlobalCoord = isHorizontal
            ? function (coord) {
                return coord + coordBase;
            }
            : function (coord) {
                return extentSum - coord + coordBase;
            };

        axis.toLocalCoord = isHorizontal
            ? function (coord) {
                return coord - coordBase;
            }
            : function (coord) {
                return extentSum - coord + coordBase;
            };
    }

    private _calculateSeriesLabelBoundingRects(seriesList: SeriesModel[], api: ExtensionAPI): Array<{
        rect: BoundingRect;
        textAlign: string;
    }> {
        const singleCoord = this;
        return calculateSeriesLabelBoundingRects(
            seriesList,
            api,
            (seriesModel, data) => {
                const items: Array<{
                    dataIndex: number;
                    point: number[];
                    symbolRect: BoundingRect;
                    labelText: string;
                }> = [];

                data.each((idx: number) => {
                    const dataValue = data.getValues([singleCoord.dimension], idx);
                    const point = singleCoord.dataToPoint(dataValue);
                    if (dataValue == null || !point || point.length < 2) {
                        return;
                    }

                    const symbolRect = calculateSymbolRect(seriesModel, data, idx, point, api);
                    if (!symbolRect) {
                        return;
                    }

                    const labelText = seriesModel.getFormattedLabel(idx, 'normal');
                    if (labelText == null || labelText === '') {
                        return;
                    }

                    items.push({
                        dataIndex: idx,
                        point: point,
                        symbolRect: symbolRect,
                        labelText: labelText
                    });
                });

                return items;
            }
        );
    }

    private _getRectWithAxisLabels(
        api: ExtensionAPI,
        estimateMode: boolean
    ): BoundingRect | null {
        const baseSingleRect = this.getOuterBoundingRect();
        if (!baseSingleRect) {
            return null;
        }

        const axis = this.getAxis();
        if (!axis.model) {
            return baseSingleRect.clone();
        }

        const axisBuilderSharedCtx = new AxisBuilderSharedContext(() => { });
        const layout = singleAxisHelper.layout(axis.model);
        const axisBuilder = new AxisBuilder(axis.model, api, layout, axisBuilderSharedCtx);

        axisBuilder.build({
            axisTickLabelEstimate: estimateMode,
            axisTickLabelDetermine: !estimateMode,
            axisLine: true,
            axisName: true
        });

        const axisLabelRect = axisBuilder.group.getBoundingRect();

        const singleRectWithAxisLabels = baseSingleRect.clone();
        if (axisLabelRect && axisLabelRect.width > 0 && axisLabelRect.height > 0) {
            singleRectWithAxisLabels.union(axisLabelRect);
        }

        return singleRectWithAxisLabels;
    }

    private _calculateAxisLabelOverflowMargin(
        api: ExtensionAPI,
        refContainer: RectLike,
        estimateMode: boolean
    ): number[] | null {
        const singleRectWithAxisLabels = this._getRectWithAxisLabels(api, estimateMode);
        if (!singleRectWithAxisLabels) {
            return null;
        }

        const margin = calculateRectExpansionMargin(
            refContainer,
            singleRectWithAxisLabels
        );

        return isMarginAllZero(margin) ? null : margin;
    }

    private _calculateSeriesLabelOverflowMargin(
        refContainer: RectLike,
        api: ExtensionAPI
    ): number[] | null {
        const seriesList = collectCoordLabelSeries(this._ecModel, this);
        if (seriesList.length === 0) {
            return null;
        }

        const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);
        const rawMargin = calculateSeriesLabelOverflowMargin(
            seriesLabelBoundingRects,
            refContainer
        );

        if (isMarginAllZero(rawMargin)) {
            return null;
        }

        // 单轴坐标系标签压缩需要 * 2，否则只能压缩一半
        return [
            rawMargin[0] * 2, // top
            rawMargin[1] * 2, // right
            rawMargin[2] * 2, // bottom
            rawMargin[3] * 2  // left
        ];
    }

    private _calculateLabelBoundingRect(
        api: ExtensionAPI,
        refContainer: RectLike
    ): RectLike {
        const singleRectWithAxisLabels = this._getRectWithAxisLabels(api, false);
        if (!singleRectWithAxisLabels) {
            return this.getRect();
        }

        const seriesList = collectCoordLabelSeries(this._ecModel, this);
        const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);
        if (seriesLabelBoundingRects.length > 0) {
            return calculateOuterBoundingRectWithLabels(
                singleRectWithAxisLabels,
                seriesLabelBoundingRects
            );
        }

        return singleRectWithAxisLabels;
    }

    /**
     * Get axis.
     */
    getAxis() {
        return this._axis;
    }

    /**
     * Get axis, add it just for draw tooltip.
     */
    getBaseAxis() {
        return this._axis;
    }

    getAxes() {
        return [this._axis];
    }

    getTooltipAxes() {
        return {
            baseAxes: [this.getAxis()],
            // Empty otherAxes
            otherAxes: [] as SingleAxis[]
        };
    }

    /**
     * If contain point.
     */
    containPoint(point: number[]) {
        const rect = this.getRect();
        const axis = this.getAxis();
        const orient = axis.orient;
        if (orient === 'horizontal') {
            return axis.contain(axis.toLocalCoord(point[0]))
                && (point[1] >= rect.y && point[1] <= (rect.y + rect.height));
        }
        else {
            return axis.contain(axis.toLocalCoord(point[1]))
                && (point[0] >= rect.y && point[0] <= (rect.y + rect.height));
        }
    }

    pointToData(point: number[], reserved?: null, out?: number[]) {
        out = out || [];
        const axis = this.getAxis();
        out[0] = axis.coordToData(axis.toLocalCoord(
            point[axis.orient === 'horizontal' ? 0 : 1]
        ));
        return out;
    }

    /**
     * Convert the series data to concrete point.
     * Can be [val] | val
     */
    dataToPoint(val: ScaleDataValue | ScaleDataValue[], reserved?: unknown, out?: number[]) {
        const axis = this.getAxis();
        const rect = this.getRect();
        out = out || [];
        const idx = axis.orient === 'horizontal' ? 0 : 1;

        if (val instanceof Array) {
            val = val[0];
        }

        out[idx] = axis.toGlobalCoord(axis.dataToCoord(+val));
        out[1 - idx] = idx === 0 ? (rect.y + rect.height / 2) : (rect.x + rect.width / 2);
        return out;
    }

    convertToPixel(
        ecModel: GlobalModel, finder: ParsedModelFinder, value: ScaleDataValue[]
    ) {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? this.dataToPoint(value) : null;
    }

    convertFromPixel(
        ecModel: GlobalModel, finder: ParsedModelFinder, pixel: number[]
    ) {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? this.pointToData(pixel) : null;
    }
}

function getCoordSys(finder: ParsedModelFinderKnown): Single {
    const seriesModel = finder.seriesModel;
    const singleModel = finder.singleAxisModel as SingleAxisModel;
    return singleModel && singleModel.coordinateSystem
        || seriesModel && seriesModel.coordinateSystem as Single;
}

export default Single;
