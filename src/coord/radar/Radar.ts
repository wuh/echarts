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

// TODO clockwise

import IndicatorAxis from './IndicatorAxis';
import IntervalScale from '../../scale/Interval';
import * as numberUtil from '../../util/number';
import { CoordinateSystem } from '../CoordinateSystem';
import {
    LegendAvoidableCoordinateSystem,
    LayoutLegendContext,
    fillLegendGroupSpaceToMargin,
    calculateRectWithAxisLabels,
    collectCoordLabelSeries,
    calculateRectExpansionMargin,
    calculateSeriesLabelOverflowMargin,
    applyMarginToCircularLayout,
    calculateSeriesLabelBoundingRects,
    calculateOuterBoundingRectWithLabels,
    calculateSymbolRect
} from '../../util/autoLayout';
import AxisBuilder, { AxisBuilderSharedContext } from '../../component/axis/AxisBuilder';
import RadarModel from './RadarModel';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import SeriesModel from '../../model/Series';
import { ScaleDataValue } from '../../util/types';
import { ParsedModelFinder } from '../../util/model';
import { map, each, isString, isNumber } from 'zrender/src/core/util';
import { alignScaleTicks } from '../axisAlignTicks';
import { createBoxLayoutReference } from '../../util/layout';
import { RectLike } from 'zrender';
import { expandOrShrinkRect, BoundingRect } from '../../util/graphic';
import type RadarSeriesModel from '../../chart/radar/RadarSeries';


class Radar implements CoordinateSystem, LegendAvoidableCoordinateSystem {

    readonly type: 'radar';
    /**
     *
     * Radar dimensions
     */
    readonly dimensions: string[] = [];

    cx: number;

    cy: number;

    r: number;

    r0: number;

    startAngle: number;

    /** @implements LegendAvoidableCoordinateSystem */
    autoLayoutContext: LayoutLegendContext | undefined;

    private _model: RadarModel;

    private _ecModel: GlobalModel;

    private _indicatorAxes: IndicatorAxis[];

    private _adaptiveLayout: boolean;

    constructor(radarModel: RadarModel, ecModel: GlobalModel, api: ExtensionAPI) {
        this._model = radarModel;
        this._ecModel = ecModel;

        this._indicatorAxes = map(radarModel.getIndicatorModels(), function (indicatorModel, idx) {
            const dim = 'indicator_' + idx;
            const indicatorAxis = new IndicatorAxis(dim,
                new IntervalScale()
                // (indicatorModel.get('axisType') === 'log') ? new LogScale() : new IntervalScale()
            );
            indicatorAxis.name = indicatorModel.get('name');
            // Inject model and axis
            indicatorAxis.model = indicatorModel;
            indicatorModel.axis = indicatorAxis;
            this.dimensions.push(dim);
            return indicatorAxis;
        }, this);

        this.resize(radarModel, api);
    }

    getIndicatorAxes() {
        return this._indicatorAxes;
    }

    dataToPoint(value: ScaleDataValue, indicatorIndex: number) {
        const indicatorAxis = this._indicatorAxes[indicatorIndex];

        return this.coordToPoint(indicatorAxis.dataToCoord(value), indicatorIndex);
    }

    // TODO: API should be coordToPoint([coord, indicatorIndex])
    coordToPoint(coord: number, indicatorIndex: number) {
        const indicatorAxis = this._indicatorAxes[indicatorIndex];
        const angle = indicatorAxis.angle;
        const x = this.cx + coord * Math.cos(angle);
        const y = this.cy - coord * Math.sin(angle);
        return [x, y];
    }

    pointToData(pt: number[]) {
        let dx = pt[0] - this.cx;
        let dy = pt[1] - this.cy;
        const radius = Math.sqrt(dx * dx + dy * dy);
        dx /= radius;
        dy /= radius;

        const radian = Math.atan2(-dy, dx);

        // Find the closest angle
        // FIXME index can calculated directly
        let minRadianDiff = Infinity;
        let closestAxis;
        let closestAxisIdx = -1;
        for (let i = 0; i < this._indicatorAxes.length; i++) {
            const indicatorAxis = this._indicatorAxes[i];
            const diff = Math.abs(radian - indicatorAxis.angle);
            if (diff < minRadianDiff) {
                closestAxis = indicatorAxis;
                closestAxisIdx = i;
                minRadianDiff = diff;
            }
        }

        return [closestAxisIdx, +(closestAxis && closestAxis.coordToData(radius))];
    }

    resize(radarModel: RadarModel, api: ExtensionAPI) {
        const refContainer = createBoxLayoutReference(radarModel, api).refContainer;

        const center = radarModel.get('center');
        const clockwise = radarModel.get('clockwise') || false;
        const viewSize = Math.min(refContainer.width, refContainer.height) / 2;
        this.cx = numberUtil.parsePercent(center[0], refContainer.width) + refContainer.x;
        this.cy = numberUtil.parsePercent(center[1], refContainer.height) + refContainer.y;

        this.startAngle = radarModel.get('startAngle') * Math.PI / 180;

        // radius may be single value like `20`, `'80%'`, or array like `[10, '80%']`
        let radius = radarModel.get('radius');
        if (isString(radius) || isNumber(radius)) {
            radius = [0, radius];
        }
        this.r0 = numberUtil.parsePercent(radius[0], viewSize);
        this.r = numberUtil.parsePercent(radius[1], viewSize);

        let finalBoundingRect: RectLike;
        // 处理自动布局
        if (this.autoLayoutContext != null) {
            if (this.autoLayoutContext.needLayout) {
                // 计算包含所有标签的矩形用于图例避让
                finalBoundingRect = this._calculateLabelBoundingRect(api, refContainer);
                fillLegendGroupSpaceToMargin(
                    this.autoLayoutContext.group,
                    api,
                    finalBoundingRect,
                    null,
                    this.autoLayoutContext
                );
            }

            // 应用margin调整到半径和中心点
            if (this.autoLayoutContext.margin != null) {
                const contextMargin = this.autoLayoutContext.margin;
                const adjustedLayout = applyMarginToCircularLayout(
                    contextMargin, this.cx, this.cy, this.r, this.r0
                );

                this.cx = adjustedLayout.cx;
                this.cy = adjustedLayout.cy;
                this.r = adjustedLayout.r;

                // 使用计算出的压缩量来扩展矩形
                finalBoundingRect && expandOrShrinkRect(finalBoundingRect, contextMargin, true, true);
            }
        }

        // 处理自动标签溢出
        if (this._adaptiveLayout) {
            // 计算需要压缩的margin（估算模式）
            const labelOverflowMargin = this._calculateLabelOverflowMargin(api, refContainer, true);
            // 应用margin调整到半径和中心点
            const adjustedLayout = applyMarginToCircularLayout(
                labelOverflowMargin, this.cx, this.cy, this.r, this.r0
            );

            this.cx = adjustedLayout.cx;
            this.cy = adjustedLayout.cy;
            this.r = adjustedLayout.r;
            finalBoundingRect && expandOrShrinkRect(finalBoundingRect, labelOverflowMargin, true, true);
        }

        // 在 radar 布局完成后，基于最终的 radarRect 设置自动布局的最终外接矩形
        if (this.autoLayoutContext?.needLayout === true) {
            this.autoLayoutContext.finalBoundingRect = finalBoundingRect;
        }

        const sign = clockwise ? -1 : 1;

        each(this._indicatorAxes, function (indicatorAxis, idx) {
            indicatorAxis.setExtent(this.r0, this.r);
            let angle = (this.startAngle + sign * idx * Math.PI * 2 / this._indicatorAxes.length);
            // Normalize to [-PI, PI]
            angle = Math.atan2(Math.sin(angle), Math.cos(angle));
            indicatorAxis.angle = angle;
        }, this);
    }

    /**
     * 构建轴构建器的共享上下文。
     *
     * 注意：estimateMode为true时只计算坐标和尺寸（用于推断空间），为false则完整
     * 构建。这里通过 AxisBuilder 构造实际的轴、标签、刻度等，复用
     * AxisBuilderSharedContext 以便收集布局信息避免重复遍历。
     */
    private _buildAxisBuilderSharedContext(
        api: ExtensionAPI,
        estimateMode: boolean = false
    ): AxisBuilderSharedContext {
        // 创建共享上下文，用于收集各轴的标签边界，用来辅助自适应布局
        const axisBuilderSharedCtx = new AxisBuilderSharedContext(() => { });
        each(this._indicatorAxes, indicatorAxis => {
            // 显示轴名需根据实际配置而定，若禁用showName则不展示
            const axisName = indicatorAxis.model.get('showName') ? indicatorAxis.name : '';
            // 为每个指示器轴创建AxisBuilder，指定中心、旋转角度以及标签/刻度方向
            const axisBuilder = new AxisBuilder(indicatorAxis.model, api, {
                axisName: axisName,
                position: [this.cx, this.cy],
                rotation: indicatorAxis.angle,
                labelDirection: -1,
                tickDirection: -1,
                nameDirection: 1
            }, axisBuilderSharedCtx);

            // build时可以只推断坐标和标签排布，不作真实绘制，用于估算溢出（estimateMode）
            axisBuilder.build({
                axisTickLabelEstimate: estimateMode,
                axisTickLabelDetermine: !estimateMode,
                axisLine: true,
                axisName: true
            });
        });
        return axisBuilderSharedCtx;
    }

    /**
     * 计算雷达坐标系中轴标签和系列标签所需的溢出margin。
     *
     * 该margin被用于压缩实际雷达半径，使所有标签完整展示且不溢出refContainer容器外。
     *
     * @param refContainer 参照容器，一般是图表的主绘图区
     * @returns [top, right, bottom, left]格式的margin数组
     */
    private _calculateLabelOverflowMargin(
        api: ExtensionAPI,
        refContainer: import('zrender').RectLike,
        estimateMode: boolean
    ): number[] {
        // 构建当前布局对应的标签共享信息，用于后续计算溢出
        const axisBuilderSharedCtx = this._buildAxisBuilderSharedContext(api, estimateMode);

        // 计算未考虑标签时，雷达的基础外包矩形
        const baseRadarRect = this.getOuterBoundingRect();

        // 基于标签和轴信息，得到包含词所有轴标签的扩展雷达外包矩形
        const radarRectWithAxisLabels = calculateRectWithAxisLabels(
            baseRadarRect, this._indicatorAxes, axisBuilderSharedCtx
        );

        // 计算所有轴标签溢出基础容器的margin（即为防止标签被裁剪最小所需padding）
        const axisLabelOverflowMargin = calculateRectExpansionMargin(
            refContainer,
            radarRectWithAxisLabels
        );

        // 收集当前坐标系之下所有需要参与布局的系列（如各数据维度的标签）
        const seriesList = collectCoordLabelSeries(this._ecModel, this) as RadarSeriesModel[];
        let seriesLabelOverflowMargin = [0, 0, 0, 0];
        if (seriesList.length > 0) {
            // 计算所有系列标签的包络矩形（如雷达线上value的label等），用于溢出判断
            const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);

            // 基于系列包络，计算系列标签需要的额外margin
            seriesLabelOverflowMargin = calculateSeriesLabelOverflowMargin(
                seriesLabelBoundingRects,
                refContainer
            );
        }

        // 轴标签与系列标签可能向四周最大外扩，合并二者所需margin
        return [
            Math.max(axisLabelOverflowMargin[0], seriesLabelOverflowMargin[0]), // top
            Math.max(axisLabelOverflowMargin[1], seriesLabelOverflowMargin[1]), // right
            Math.max(axisLabelOverflowMargin[2], seriesLabelOverflowMargin[2]), // bottom
            Math.max(axisLabelOverflowMargin[3], seriesLabelOverflowMargin[3])  // left
        ];
    }

    /**
     * 计算包含所有轴标签和系列标签的最终外包矩形（用于图例避让、自适应布局等）。
     *
     * @param refContainer 主绘图区矩形
     */
    private _calculateLabelBoundingRect(
        api: ExtensionAPI,
        refContainer: import('zrender').RectLike
    ): import('zrender').RectLike {
        // 首先收集含轴标签的共享上下文信息，避免重复推断
        const axisBuilderSharedCtx = this._buildAxisBuilderSharedContext(api, false);

        // 原始（不包含标签）雷达主体的包围盒
        const baseRadarRect = this.getOuterBoundingRect();

        // 扩展包围盒，使其完整覆盖所有轴标签
        const radarRectWithAxisLabels = calculateRectWithAxisLabels(
            baseRadarRect, this._indicatorAxes, axisBuilderSharedCtx
        );

        // 若有系列，需进一步包含所有系列标签的矩形
        const seriesList = collectCoordLabelSeries(this._ecModel, this) as RadarSeriesModel[];
        if (seriesList.length > 0) {
            const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);

            // 合并所有包络面，得到最终雷达外部边界
            return calculateOuterBoundingRectWithLabels(
                radarRectWithAxisLabels,
                seriesLabelBoundingRects
            );
        }

        // 若无系列标签，仅返回轴标签扩展后的包络盒
        return radarRectWithAxisLabels;
    }

    /**
     * 获取当前雷达坐标系的最小外包矩形。
     *
     * 若为polygon形状，则精确包络所有顶点；若为circle或无法确定，则以圆心和半径
     * 构建正方形包围盒。
     * @implements LegendAvoidableCoordinateSystem
     */
    getOuterBoundingRect(): RectLike {
        const shape = this._model.get('shape') || 'polygon';

        // 对于多边形雷达，需遍历所有顶点，得到真实的最小外包范围
        if (shape === 'polygon' && this._indicatorAxes.length > 0) {
            const points: number[][] = [];

            // 计算每个维度的最大外圈点坐标
            each(this._indicatorAxes, (indicatorAxis, index) => {
                const point = this.coordToPoint(this.r, index);
                points.push([point[0], point[1]]);
            });

            if (points.length > 0) {
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;

                // 得到所有点的最大最小横纵坐标
                each(points, point => {
                    minX = Math.min(minX, point[0]);
                    minY = Math.min(minY, point[1]);
                    maxX = Math.max(maxX, point[0]);
                    maxY = Math.max(maxY, point[1]);
                });

                // 构建多边形的最小包围矩形
                return {
                    x: minX,
                    y: minY,
                    width: maxX - minX,
                    height: maxY - minY
                };
            }
        }

        // 若为圆形或没有有效多边形点，则直接以圆心与半径为准，返回包围盒
        const r = this.r;
        return {
            x: this.cx - r,
            y: this.cy - r,
            width: r * 2,
            height: r * 2
        };
    }

    /** @implements LegendAvoidableCoordinateSystem */
    applyAutoLayout(ecModel: GlobalModel, api: ExtensionAPI): void {
        // 自动布局时可利用已有 update，自动完成半径/中心及margin自适应
        this.update(ecModel, api);
    }

    /**
     * 计算所有系列（即所有极坐标标签）在当前雷达上的外包矩形。
     *
     * 返回值为每个系列标签的BoundingRect（含textAlign等），用于用于判断整体溢出
     * 边界，支持自适应布局与图例避让策略。
     *
     * @param seriesList 本坐标系中所有相关系列
     * @param api 扩展API
     */
    private _calculateSeriesLabelBoundingRects(seriesList: SeriesModel[], api: ExtensionAPI): Array<{
        rect: BoundingRect;
        textAlign: string;
    }> {
        const radar = this;
        return calculateSeriesLabelBoundingRects(
            seriesList,
            api,
            // 回调：遍历单个系列中每个数据点，收集其在雷达坐标上的几何与标签信息
            (seriesModel, data) => {
                const indicatorAxes = radar.getIndicatorAxes();
                const items: Array<{
                    dataIndex: number;
                    point: number[];
                    symbolRect: BoundingRect;
                    labelText: string;
                    extraFormatParams?: any;
                }> = [];

                data.each(function (dataIndex: number) {
                    each(indicatorAxes, function (indicatorAxis: IndicatorAxis, indicatorIndex) {
                        // 获取当前维度的原始数据值（如无数据跳过）
                        const value = data.get(data.mapDimension(indicatorAxis.dim), dataIndex);
                        if (value == null) {
                            return;
                        }

                        // 将雷达数据转为实际坐标点（如极坐标上的x/y）
                        const point = radar.dataToPoint(value, indicatorIndex);
                        if (!point || point.length < 2) {
                            return;
                        }

                        // 计算数据点符号本身所占据的矩形（如小圆/多边形symbol）
                        const symbolRect = calculateSymbolRect(seriesModel, data, dataIndex, point, api);
                        if (!symbolRect) {
                            return;
                        }

                        // 获取每个数据点的格式化标签文本（为空则不计入布局）
                        const labelText = seriesModel.getFormattedLabel(
                            dataIndex,
                            'normal',
                            null,
                            indicatorIndex as number
                        );
                        if (labelText == null || labelText === '') {
                            return;
                        }

                        // 收集所有可视数据点及其关联标签区域，便于后续整体布局分析
                        items.push({
                            dataIndex: dataIndex,
                            point: point,
                            symbolRect: symbolRect,
                            labelText: labelText,
                            extraFormatParams: indicatorIndex
                        });
                    });
                });

                return items;
            }
        );
    }

    update(ecModel: GlobalModel, api: ExtensionAPI) {
        const indicatorAxes = this._indicatorAxes;
        const radarModel = this._model;
        each(indicatorAxes, function (indicatorAxis) {
            indicatorAxis.scale.setExtent(Infinity, -Infinity);
        });
        ecModel.eachSeriesByType('radar', function (radarSeries, idx) {
            if (radarSeries.get('coordinateSystem') !== 'radar'
                // @ts-ignore
                || ecModel.getComponent('radar', radarSeries.get('radarIndex')) !== radarModel
            ) {
                return;
            }
            const data = radarSeries.getData();
            each(indicatorAxes, function (indicatorAxis) {
                indicatorAxis.scale.unionExtentFromData(data, data.mapDimension(indicatorAxis.dim));
            });
        }, this);

        const splitNumber = radarModel.get('splitNumber');
        const dummyScale = new IntervalScale();
        dummyScale.setExtent(0, splitNumber);
        dummyScale.setInterval(1);
        // Force all the axis fixing the maxSplitNumber.
        each(indicatorAxes, function (indicatorAxis, idx) {
            alignScaleTicks(
                indicatorAxis.scale as IntervalScale,
                indicatorAxis.model,
                dummyScale
            );
        });

        // 更新adaptiveLayout状态
        const adaptiveLayout = this._adaptiveLayout = this._model.get('adaptiveLayout') || false;
        // 检查自动布局上下文或adaptiveLayout，如果需要布局则调用resize
        if (this.autoLayoutContext != null || adaptiveLayout) {
            this.resize(this._model, api);
        }
    }

    convertToPixel(ecModel: GlobalModel, finder: ParsedModelFinder, value: ScaleDataValue[]): never {
        console.warn('Not implemented.');
        return null as never;
    }
    convertFromPixel(ecModel: GlobalModel, finder: ParsedModelFinder, pixel: number[]): never {
        console.warn('Not implemented.');
        return null as never;
    }
    containPoint(point: number[]): boolean {
        console.warn('Not implemented.');
        return false;
    }
    /**
     * Radar dimensions is based on the data
     */
    static dimensions: string[] = [];

    static create(ecModel: GlobalModel, api: ExtensionAPI) {
        const radarList: Radar[] = [];
        ecModel.eachComponent('radar', function (radarModel: RadarModel) {
            const radar = new Radar(radarModel, ecModel, api);
            radarList.push(radar);
            radarModel.coordinateSystem = radar;
        });
        ecModel.eachSeriesByType('radar', function (radarSeries) {
            if (radarSeries.get('coordinateSystem') === 'radar') {
                // Inject coordinate system
                // @ts-ignore
                radarSeries.coordinateSystem = radarList[radarSeries.get('radarIndex') || 0];
            }
        });
        return radarList;
    }
}


export default Radar;
