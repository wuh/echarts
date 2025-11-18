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

import RadiusAxis from './RadiusAxis';
import AngleAxis from './AngleAxis';
import PolarModel from './PolarModel';
import { CoordinateSystem, CoordinateSystemMaster, CoordinateSystemClipArea } from '../CoordinateSystem';
import GlobalModel from '../../model/Global';
import { ParsedModelFinder, ParsedModelFinderKnown } from '../../util/model';
import { ScaleDataValue, ZRRectLike } from '../../util/types';
import ExtensionAPI from '../../core/ExtensionAPI';
import {
    LegendAvoidableCoordinateSystem,
    LayoutLegendContext,
    fillLegendGroupSpaceToMargin,
    calculateRectWithAxisLabels,
    applyMarginToCircularLayout
} from '../../util/autoLayout';
import BoundingRect from 'zrender/src/core/BoundingRect';
import AxisBuilder, { AxisBuilderSharedContext, getLabelInner } from '../../component/axis/AxisBuilder';
import { expandOrShrinkRect } from '../../util/graphic';

export const polarDimensions = ['radius', 'angle'];

interface Polar {
    update(ecModel: GlobalModel, api: ExtensionAPI): void
}
class Polar implements CoordinateSystem, CoordinateSystemMaster, LegendAvoidableCoordinateSystem {

    readonly name: string;

    readonly dimensions = polarDimensions;

    readonly type = 'polar';

    /**
     * x of polar center
     */
    cx = 0;

    /**
     * y of polar center
     */
    cy = 0;

    private _radiusAxis = new RadiusAxis();

    private _angleAxis = new AngleAxis();

    axisPointerEnabled = true;

    model: PolarModel;

    /** @implements LegendAvoidableCoordinateSystem */
    autoLayoutContext: LayoutLegendContext | undefined;

    constructor(name: string) {
        this.name = name || '';

        this._radiusAxis.polar = this._angleAxis.polar = this;
    }

    /**
     * If contain coord
     */
    containPoint(point: number[]) {
        const coord = this.pointToCoord(point);
        return this._radiusAxis.contain(coord[0])
            && this._angleAxis.contain(coord[1]);
    }

    /**
     * If contain data
     */
    containData(data: number[]) {
        return this._radiusAxis.containData(data[0])
            && this._angleAxis.containData(data[1]);
    }

    getAxis(dim: 'radius' | 'angle') {
        const key = ('_' + dim + 'Axis') as '_radiusAxis' | '_angleAxis';
        return this[key];
    }

    getAxes() {
        return [this._radiusAxis, this._angleAxis];
    }

    /**
     * Get axes by type of scale
     */
    getAxesByScale(scaleType: 'ordinal' | 'interval' | 'time' | 'log') {
        const axes = [];
        const angleAxis = this._angleAxis;
        const radiusAxis = this._radiusAxis;
        angleAxis.scale.type === scaleType && axes.push(angleAxis);
        radiusAxis.scale.type === scaleType && axes.push(radiusAxis);

        return axes;
    }

    getAngleAxis() {
        return this._angleAxis;
    }

    getRadiusAxis() {
        return this._radiusAxis;
    }

    getOtherAxis(axis: AngleAxis | RadiusAxis): AngleAxis | RadiusAxis {
        const angleAxis = this._angleAxis;
        return axis === angleAxis ? this._radiusAxis : angleAxis;
    }

    /**
     * Base axis will be used on stacking.
     *
     */
    getBaseAxis() {
        return this.getAxesByScale('ordinal')[0]
            || this.getAxesByScale('time')[0]
            || this.getAngleAxis();
    }

    getTooltipAxes(dim: 'radius' | 'angle' | 'auto') {
        const baseAxis = (dim != null && dim !== 'auto')
            ? this.getAxis(dim) : this.getBaseAxis();
        return {
            baseAxes: [baseAxis],
            otherAxes: [this.getOtherAxis(baseAxis)]
        };
    }

    /**
     * Convert a single data item to (x, y) point.
     * Parameter data is an array which the first element is radius and the second is angle
     */
    dataToPoint(data: ScaleDataValue[], clamp?: boolean, out?: number[]) {
        return this.coordToPoint([
            this._radiusAxis.dataToRadius(data[0], clamp),
            this._angleAxis.dataToAngle(data[1], clamp)
        ], out);
    }

    /**
     * Convert a (x, y) point to data
     */
    pointToData(point: number[], clamp?: boolean, out?: number[]) {
        out = out || [];
        const coord = this.pointToCoord(point);
        out[0] = this._radiusAxis.radiusToData(coord[0], clamp);
        out[1] = this._angleAxis.angleToData(coord[1], clamp);
        return out;
    }

    /**
     * Convert a (x, y) point to (radius, angle) coord
     */
    pointToCoord(point: number[]) {
        let dx = point[0] - this.cx;
        let dy = point[1] - this.cy;
        const angleAxis = this.getAngleAxis();
        const extent = angleAxis.getExtent();
        let minAngle = Math.min(extent[0], extent[1]);
        let maxAngle = Math.max(extent[0], extent[1]);
        // Fix fixed extent in polarCreator
        // FIXME
        angleAxis.inverse
            ? (minAngle = maxAngle - 360)
            : (maxAngle = minAngle + 360);

        const radius = Math.sqrt(dx * dx + dy * dy);
        dx /= radius;
        dy /= radius;

        let radian = Math.atan2(-dy, dx) / Math.PI * 180;

        // move to angleExtent
        const dir = radian < minAngle ? 1 : -1;
        while (radian < minAngle || radian > maxAngle) {
            radian += dir * 360;
        }

        return [radius, radian];
    }

    /**
     * Convert a (radius, angle) coord to (x, y) point
     */
    coordToPoint(coord: number[], out?: number[]) {
        out = out || [];
        const radius = coord[0];
        const radian = coord[1] / 180 * Math.PI;
        out[0] = Math.cos(radian) * radius + this.cx;
        // Inverse the y
        out[1] = -Math.sin(radian) * radius + this.cy;

        return out;
    }

    /**
     * Get ring area of cartesian.
     * Area will have a contain function to determine if a point is in the coordinate system.
     */
    getArea(): PolarArea {

        const angleAxis = this.getAngleAxis();
        const radiusAxis = this.getRadiusAxis();

        const radiusExtent = radiusAxis.getExtent().slice();
        radiusExtent[0] > radiusExtent[1] && radiusExtent.reverse();
        const angleExtent = angleAxis.getExtent();

        const RADIAN = Math.PI / 180;
        const EPSILON = 1e-4;
        return {
            cx: this.cx,
            cy: this.cy,
            r0: radiusExtent[0],
            r: radiusExtent[1],
            startAngle: -angleExtent[0] * RADIAN,
            endAngle: -angleExtent[1] * RADIAN,
            clockwise: angleAxis.inverse,
            contain(x: number, y: number) {
                // It's a ring shape.
                // Start angle and end angle don't matter
                const dx = x - this.cx;
                const dy = y - this.cy;
                const d2 = dx * dx + dy * dy;
                const r = this.r;
                const r0 = this.r0;

                // minus a tiny value 1e-4 in double side to avoid being clipped unexpectedly
                // r == r0 contain nothing
                return r !== r0 && (d2 - EPSILON) <= r * r && (d2 + EPSILON) >= r0 * r0;
            },

            // As the bounding box
            x: this.cx - radiusExtent[1],
            y: this.cy - radiusExtent[1],
            width: radiusExtent[1] * 2,
            height: radiusExtent[1] * 2
        };
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

    /** @implements LegendAvoidableCoordinateSystem */
    getOuterBoundingRect(): BoundingRect | null {
        const area = this.getArea();
        return new BoundingRect(
            area.x,
            area.y,
            area.width,
            area.height
        );
    }

    /** @implements LegendAvoidableCoordinateSystem */
    applyAutoLayout(ecModel: GlobalModel, api: ExtensionAPI): void {
        this.update(ecModel, api);
        const autoLayoutContext = this.autoLayoutContext;
        // 检查自动布局上下文是否存在
        if (autoLayoutContext == null) {
            return;
        }

        const radiusAxis = this.getRadiusAxis();
        const angleAxis = this.getAngleAxis();

        // 计算包含轴标签的矩形
        let polarRectWithAxisLabels: ZRRectLike;
        if (autoLayoutContext.needLayout === true) {
            // 创建轴构建器共享上下文来计算包含轴标签的矩形
            const axisBuilderSharedCtx = new AxisBuilderSharedContext(() => {});

            // 为半径轴和角度轴构建轴以获取标签信息，直接使用RadiusAxisView的layoutAxis函数
            if (radiusAxis.model) {
                const axisAngle = angleAxis.getExtent()[0];
                const layout = {
                    position: [this.cx, this.cy],
                    rotation: axisAngle / 180 * Math.PI,
                    labelDirection: -1 as const,
                    tickDirection: -1 as const,
                    nameDirection: 1 as const,
                    labelRotate: radiusAxis.model?.getModel('axisLabel').get('rotate'),
                    // Over splitLine and splitArea
                    z2: 1
                };
                const axisBuilder = new AxisBuilder(radiusAxis.model, api, layout, axisBuilderSharedCtx);
                // 构建必要的部分用于布局计算，先估算再确定
                axisBuilder.build({ axisTickLabelEstimate: true, axisName: true });
            }
            if (angleAxis.model) {
                // 为角度轴创建布局参数，参考AngleAxisView的处理方式
                const layout = {
                    position: [this.cx, this.cy],
                    rotation: 0,
                    labelDirection: -1 as const,
                    tickDirection: -1 as const,
                    nameDirection: 1 as const,
                    labelRotate: angleAxis.model.getModel('axisLabel').get('rotate'),
                    z2: 1
                };
                const axisBuilder = new AxisBuilder(angleAxis.model, api, layout, axisBuilderSharedCtx);
                // 构建必要的部分用于布局计算，先估算再确定
                axisBuilder.build({ axisTickLabelEstimate: true, axisName: true });
                const sharedRecord = axisBuilderSharedCtx.ensureRecord(angleAxis.model);
                 // 调整角度轴标签的rect位置，使其反映环形分布
                if (sharedRecord.labelInfoList) {
                    const radiusExtent = radiusAxis.getExtent();
                    const r = radiusExtent[1]; // 使用外半径
                    const labelMargin = angleAxis.model.getModel('axisLabel').get('margin') || 8;

                    sharedRecord.labelInfoList.forEach(labelInfo => {
                        // 获取标签的角度坐标
                        const labelInner = getLabelInner(labelInfo.label);
                        const tickValue = labelInner.tickValue;
                        const angleCoord = angleAxis.dataToCoord(tickValue);
                        // 计算在极坐标中的位置
                        const point = this.coordToPoint([r + labelMargin, angleCoord]);
                        // 更新rect的中心位置
                        labelInfo.rect.x = point[0] - labelInfo.rect.width / 2;
                        labelInfo.rect.y = point[1] - labelInfo.rect.height / 2;
                    });
                }
            }

            // 计算包含轴标签的基础Polar矩形
            const basePolarRect = this.getOuterBoundingRect();

            // 使用calculateRectWithAxisLabels计算准确的包含标签的矩形
            polarRectWithAxisLabels = calculateRectWithAxisLabels(
                basePolarRect, [radiusAxis, angleAxis], axisBuilderSharedCtx
            );

            // 填充图例空间到 margin
            fillLegendGroupSpaceToMargin(
                autoLayoutContext.group,
                api,
                polarRectWithAxisLabels,
                null,
                autoLayoutContext
            );
        }
        else {
            // 使用基础外接矩形
            polarRectWithAxisLabels = this.getOuterBoundingRect();
        }

        // 应用margin调整到半径和中心点
        if (autoLayoutContext.margin != null) {
            const contextMargin = this.autoLayoutContext.margin;
            const area = this.getArea();

            const adjustedLayout = applyMarginToCircularLayout(
                contextMargin, this.cx, this.cy, area.r, area.r0
            );

            this.cx = adjustedLayout.cx;
            this.cy = adjustedLayout.cy;

            // 更新半径轴的范围
            radiusAxis.inverse
                ? radiusAxis.setExtent(adjustedLayout.r, area.r0)
                : radiusAxis.setExtent(area.r0, adjustedLayout.r);

            // 使用计算出的压缩量来扩展矩形
            if (autoLayoutContext.needLayout) {
                expandOrShrinkRect(polarRectWithAxisLabels, contextMargin, true, true);
            }
        }

        // 设置最终的外接矩形
        autoLayoutContext.finalBoundingRect = polarRectWithAxisLabels;
    }
}

function getCoordSys(finder: ParsedModelFinderKnown) {
    const seriesModel = finder.seriesModel;
    const polarModel = finder.polarModel as PolarModel;
    return polarModel && polarModel.coordinateSystem
        || seriesModel && seriesModel.coordinateSystem as Polar;
}

interface PolarArea extends CoordinateSystemClipArea {
    cx: number
    cy: number
    r0: number
    r: number
    startAngle: number
    endAngle: number
    clockwise: boolean
}

export default Polar;
