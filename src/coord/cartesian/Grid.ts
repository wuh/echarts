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
 * Grid is a region which contains at most 4 cartesian systems
 *
 * TODO Default cartesian
 */

import {isObject, each, indexOf, retrieve3, keys, assert, eqNaN, find, retrieve2} from 'zrender/src/core/util';
import {BoxLayoutReferenceResult, createBoxLayoutReference, getLayoutRect, LayoutRect} from '../../util/layout';
import {
    createScaleByModel,
    ifAxisCrossZero,
    niceScaleExtent,
    getDataDimensionsOnAxis,
    isNameLocationCenter,
    shouldAxisShow,
} from '../../coord/axisHelper';
import Cartesian2D, {cartesian2DDimensions} from './Cartesian2D';
import Axis2D from './Axis2D';
import {ParsedModelFinder, ParsedModelFinderKnown, SINGLE_REFERRING} from '../../util/model';

// Depends on GridModel, AxisModel, which performs preprocess.
import GridModel, { GridOption, OUTER_BOUNDS_CLAMP_DEFAULT, OUTER_BOUNDS_DEFAULT } from './GridModel';
import CartesianAxisModel from './AxisModel';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import SeriesModel from '../../model/Series';
import { Dictionary } from 'zrender/src/core/types';
import {CoordinateSystemMaster} from '../CoordinateSystem';
import { NullUndefined, ScaleDataValue } from '../../util/types';
import SeriesData from '../../data/SeriesData';
import OrdinalScale from '../../scale/Ordinal';
import {
    findAxisModels,
    createCartesianAxisViewCommonPartBuilder,
    updateCartesianAxisViewCommonPartBuilder,
    isCartesian2DInjectedAsDataCoordSys
} from './cartesianAxisHelper';
import { CategoryAxisBaseOption, NumericAxisBaseOptionCommon } from '../axisCommonTypes';
import { AxisBaseModel } from '../AxisBaseModel';
import { isIntervalOrLogScale } from '../../scale/helper';
import { alignScaleTicks } from '../axisAlignTicks';
import IntervalScale from '../../scale/Interval';
import LogScale from '../../scale/Log';
import { BoundingRect, expandOrShrinkRect, WH, XY } from '../../util/graphic';
import {
    AxisBuilderSharedContext,
    resolveAxisNameOverlapDefault,
    moveIfOverlapByLinearLabels,
    getLabelInner,
} from '../../component/axis/AxisBuilder';
import { error, log } from '../../util/log';
import { AxisTickLabelComputingKind } from '../axisTickLabelBuilder';
import { injectCoordSysByOption } from '../../core/CoordinateSystem';
import { mathMax, parsePositionSizeOption } from '../../util/number';
import {
    LayoutLegendContext,
    LegendAvoidableCoordinateSystem,
    fillLegendGroupSpaceToMargin,
    calculateRectWithAxisLabels,
    calculateOuterBoundingRectWithLabels,
    collectCoordLabelSeries,
    calculateSeriesLabelBoundingRects,
    calculateSymbolRect
} from '../../util/autoLayout';

type Cartesian2DDimensionName = 'x' | 'y';

type FinderAxisIndex = {xAxisIndex?: number, yAxisIndex?: number};
type AxesMap = {
    x: Axis2D[],
    y: Axis2D[]
};

type ParsedOuterBoundsContain = 'all' | 'axisLabel';

// margin is [top, right, bottom, left]
const XY_TO_MARGIN_IDX = [
    [3, 1], // xyIdx 0 => 'x'
    [0, 2]  // xyIdx 1 => 'y'
] as const;

class Grid implements CoordinateSystemMaster, LegendAvoidableCoordinateSystem {

    // FIXME:TS where used (different from registered type 'cartesian2d')?
    readonly type: string = 'grid';

    private _coordsMap: Dictionary<Cartesian2D> = {};
    private _coordsList: Cartesian2D[] = [];
    private _axesMap: AxesMap = {} as AxesMap;
    private _axesList: Axis2D[] = [];
    private _rect: LayoutRect;
    /** @implements LegendAvoidableCoordinateSystem */
    public autoLayoutContext: LayoutLegendContext | undefined;

    readonly model: GridModel;
    readonly axisPointerEnabled = true;

    // Injected:
    name: string;

    // For deciding which dimensions to use when creating list data
    static dimensions = cartesian2DDimensions;
    readonly dimensions = cartesian2DDimensions;

    constructor(gridModel: GridModel, ecModel: GlobalModel, api: ExtensionAPI) {
        this._initCartesian(gridModel, ecModel, api);
        this.model = gridModel;
    }

    getRect(): LayoutRect {
        return this._rect;
    }

    /** @implements LegendAvoidableCoordinateSystem */
    getOuterBoundingRect(): LayoutRect {
        return this._rect;
    }

    /** @implements LegendAvoidableCoordinateSystem */
    applyAutoLayout(ecModel: GlobalModel, api: ExtensionAPI): void {
        // 调用现有的 update 方法进行压缩布局计算（已包含系列标签压缩）
        this.update(ecModel, api);
    }

    update(ecModel: GlobalModel, api: ExtensionAPI): void {

        const axesMap = this._axesMap;

        this._updateScale(ecModel, this.model);

        function updateAxisTicks(axes: Record<number, Axis2D>) {
            let alignTo: Axis2D;
            // Axis is added in order of axisIndex.
            const axesIndices = keys(axes);
            const len = axesIndices.length;
            if (!len) {
                return;
            }
            const axisNeedsAlign: Axis2D[] = [];
            // Process once and calculate the ticks for those don't use alignTicks.
            for (let i = len - 1; i >= 0; i--) {
                const idx = +axesIndices[i];    // Convert to number.
                const axis = axes[idx];
                const model = axis.model as AxisBaseModel<NumericAxisBaseOptionCommon>;
                const scale = axis.scale;
                if (// Only value and log axis without interval support alignTicks.
                    isIntervalOrLogScale(scale)
                    && model.get('alignTicks')
                    && model.get('interval') == null
                ) {
                    axisNeedsAlign.push(axis);
                }
                else {
                    niceScaleExtent(scale, model);
                    if (isIntervalOrLogScale(scale)) {  // Can only align to interval or log axis.
                        alignTo = axis;
                    }
                }
            };
            // All axes has set alignTicks. Pick the first one.
            // PENDING. Should we find the axis that both set interval, min, max and align to this one?
            if (axisNeedsAlign.length) {
                if (!alignTo) {
                    alignTo = axisNeedsAlign.pop();
                    niceScaleExtent(alignTo.scale, alignTo.model);
                }

                each(axisNeedsAlign, axis => {
                    alignScaleTicks(
                        axis.scale as IntervalScale | LogScale,
                        axis.model,
                        alignTo.scale as IntervalScale | LogScale
                    );
                });
            }
        }

        updateAxisTicks(axesMap.x);
        updateAxisTicks(axesMap.y);

        // Key: axisDim_axisIndex, value: boolean, whether onZero target.
        const onZeroRecords = {} as Dictionary<boolean>;

        each(axesMap.x, function (xAxis) {
            fixAxisOnZero(axesMap, 'y', xAxis, onZeroRecords);
        });
        each(axesMap.y, function (yAxis) {
            fixAxisOnZero(axesMap, 'x', yAxis, onZeroRecords);
        });

        // Resize again if containLabel is enabled
        // FIXME It may cause getting wrong grid size in data processing stage
        this.resize(this.model, api);
    }

    /**
     * Resize the grid.
     *
     * [NOTE]
     * If both "grid.containLabel/grid.contain" and pixel-required-data-processing (such as, "dataSampling")
     * exist, circular dependency occurs in logic.
     * The final compromised sequence is:
     *  1. Calculate "axis.extent" (pixel extent) and AffineTransform based on only "grid layout options".
     *      Not accurate if "grid.containLabel/grid.contain" is required, but it is a compromise to avoid
     *      circular dependency.
     *  2. Perform "series data processing" (where "dataSampling" requires "axis.extent").
     *  3. Calculate "scale.extent" (data extent) based on "processed series data".
     *  4. Modify "axis.extent" for "grid.containLabel/grid.contain":
     *      4.1. Calculate "axis labels" based on "scale.extent".
     *      4.2. Modify "axis.extent" by the bounding rects of "axis labels and names".
     */
    resize(gridModel: GridModel, api: ExtensionAPI, beforeDataProcessing?: boolean): void {

        const layoutRef = createBoxLayoutReference(gridModel, api);
        const gridRect = this._rect = getLayoutRect(gridModel.getBoxLayoutParams(), layoutRef.refContainer);
        // PENDING: whether to support that if the input `coord` is out of the base coord sys,
        //  do not render anything. At present, the behavior is undefined.

        const axesMap = this._axesMap;
        const coordsList = this._coordsList;

        // 收集需要自动压缩标签的系列（根据adaptiveLayout配置）
        const adaptiveLayout = gridModel.get('adaptiveLayout');
        const autoCompressSeries = adaptiveLayout
            ? collectCoordLabelSeries(api.getModel(), this)
            : undefined;

        const optionContainLabel = gridModel.get('containLabel'); // No `.get(, true)` for backward compat.

        updateAllAxisExtentTransByGridRect(axesMap, gridRect);

        if (!beforeDataProcessing) {
            const axisBuilderSharedCtx = createAxisBiulders(gridRect, coordsList, axesMap, optionContainLabel, api);

            let noPxChange: boolean;
            if (optionContainLabel) {
                if (legacyLayOutGridByContainLabel) {
                    // console.time('legacyLayOutGridByContainLabel');
                    legacyLayOutGridByContainLabel(this._axesList, gridRect);
                    updateAllAxisExtentTransByGridRect(axesMap, gridRect);
                    // console.timeEnd('legacyLayOutGridByContainLabel');
                }
                else {
                    if (__DEV__) {
                        log('Specified `grid.containLabel` but no `use(LegacyGridContainLabel)`;'
                            + 'use `grid.outerBounds` instead.',
                            true
                        );
                    }
                    noPxChange = layOutGridByOuterBounds(
                        gridRect.clone(), 'axisLabel', null, gridRect, axesMap, axisBuilderSharedCtx, layoutRef, api,
                        this, autoCompressSeries
                    );
                }
            }
            else {
                const {outerBoundsRect, parsedOuterBoundsContain, outerBoundsClamp} = prepareOuterBounds(
                    gridModel, gridRect, layoutRef
                );
                if (outerBoundsRect) {
                    // console.time('layOutGridByOuterBounds');
                    noPxChange = layOutGridByOuterBounds(
                        outerBoundsRect, parsedOuterBoundsContain, outerBoundsClamp,
                        gridRect, axesMap, axisBuilderSharedCtx, layoutRef, api,
                        this, autoCompressSeries
                    );
                    // console.timeEnd('layOutGridByOuterBounds');
                }
            }

            // console.time('buildAxesView_determine');
            createOrUpdateAxesView(
                gridRect,
                axesMap,
                AxisTickLabelComputingKind.determine,
                null,
                noPxChange,
                layoutRef
            );
            // console.timeEnd('buildAxesView_determine');
        } // End of beforeDataProcessing

        each(this._coordsList, function (coord) {
            // Calculate affine matrix to accelerate the data to point transform.
            // If all the axes scales are time or value.
            coord.calcAffineTransform();
        });
    }

    getAxis(dim: Cartesian2DDimensionName, axisIndex?: number): Axis2D {
        const axesMapOnDim = this._axesMap[dim];
        if (axesMapOnDim != null) {
            return axesMapOnDim[axisIndex || 0];
        }
    }

    getAxes(): Axis2D[] {
        return this._axesList.slice();
    }

    /**
     * Usage:
     *      grid.getCartesian(xAxisIndex, yAxisIndex);
     *      grid.getCartesian(xAxisIndex);
     *      grid.getCartesian(null, yAxisIndex);
     *      grid.getCartesian({xAxisIndex: ..., yAxisIndex: ...});
     *
     * When only xAxisIndex or yAxisIndex given, find its first cartesian.
     */
    getCartesian(finder: FinderAxisIndex): Cartesian2D;
    getCartesian(xAxisIndex?: number, yAxisIndex?: number): Cartesian2D;
    getCartesian(xAxisIndex?: number | FinderAxisIndex, yAxisIndex?: number) {
        if (xAxisIndex != null && yAxisIndex != null) {
            const key = 'x' + xAxisIndex + 'y' + yAxisIndex;
            return this._coordsMap[key];
        }

        if (isObject(xAxisIndex)) {
            yAxisIndex = (xAxisIndex as FinderAxisIndex).yAxisIndex;
            xAxisIndex = (xAxisIndex as FinderAxisIndex).xAxisIndex;
        }
        for (let i = 0, coordList = this._coordsList; i < coordList.length; i++) {
            if (coordList[i].getAxis('x').index === xAxisIndex
                || coordList[i].getAxis('y').index === yAxisIndex
            ) {
                return coordList[i];
            }
        }
    }

    getCartesians(): Cartesian2D[] {
        return this._coordsList.slice();
    }

    /**
     * @implements
     */
    convertToPixel(
        ecModel: GlobalModel, finder: ParsedModelFinder, value: ScaleDataValue | ScaleDataValue[]
    ): number | number[] {
        const target = this._findConvertTarget(finder);

        return target.cartesian
            ? target.cartesian.dataToPoint(value as ScaleDataValue[])
            : target.axis
            ? target.axis.toGlobalCoord(target.axis.dataToCoord(value as ScaleDataValue))
            : null;
    }

    /**
     * @implements
     */
    convertFromPixel(
        ecModel: GlobalModel, finder: ParsedModelFinder, value: number | number[]
    ): number | number[] {
        const target = this._findConvertTarget(finder);

        return target.cartesian
            ? target.cartesian.pointToData(value as number[])
            : target.axis
            ? target.axis.coordToData(target.axis.toLocalCoord(value as number))
            : null;
    }

    private _findConvertTarget(finder: ParsedModelFinderKnown): {
        cartesian: Cartesian2D,
        axis: Axis2D
    } {
        const seriesModel = finder.seriesModel;
        const xAxisModel = finder.xAxisModel
            || (seriesModel && seriesModel.getReferringComponents('xAxis', SINGLE_REFERRING).models[0]);
        const yAxisModel = finder.yAxisModel
            || (seriesModel && seriesModel.getReferringComponents('yAxis', SINGLE_REFERRING).models[0]);
        const gridModel = finder.gridModel;
        const coordsList = this._coordsList;
        let cartesian: Cartesian2D;
        let axis;

        if (seriesModel) {
            cartesian = seriesModel.coordinateSystem as Cartesian2D;
            indexOf(coordsList, cartesian) < 0 && (cartesian = null);
        }
        else if (xAxisModel && yAxisModel) {
            cartesian = this.getCartesian(xAxisModel.componentIndex, yAxisModel.componentIndex);
        }
        else if (xAxisModel) {
            axis = this.getAxis('x', xAxisModel.componentIndex);
        }
        else if (yAxisModel) {
            axis = this.getAxis('y', yAxisModel.componentIndex);
        }
        // Lowest priority.
        else if (gridModel) {
            const grid = gridModel.coordinateSystem;
            if (grid === this) {
                cartesian = this._coordsList[0];
            }
        }

        return {cartesian: cartesian, axis: axis};
    }

    /**
     * @implements
     */
    containPoint(point: number[]): boolean {
        const coord = this._coordsList[0];
        if (coord) {
            return coord.containPoint(point);
        }
    }

    /**
     * Initialize cartesian coordinate systems
     */
    private _initCartesian(
        gridModel: GridModel, ecModel: GlobalModel, api: ExtensionAPI
    ): void {
        const grid = this;
        const axisPositionUsed = {
            left: false,
            right: false,
            top: false,
            bottom: false
        };

        const axesMap = {
            x: {},
            y: {}
        } as AxesMap;
        const axesCount = {
            x: 0,
            y: 0
        };

        // Create axis
        ecModel.eachComponent('xAxis', createAxisCreator('x'), this);
        ecModel.eachComponent('yAxis', createAxisCreator('y'), this);

        if (!axesCount.x || !axesCount.y) {
            // Roll back when there no either x or y axis
            this._axesMap = {} as AxesMap;
            this._axesList = [];
            return;
        }

        this._axesMap = axesMap;

        // Create cartesian2d
        each(axesMap.x, (xAxis, xAxisIndex) => {
            each(axesMap.y, (yAxis, yAxisIndex) => {
                const key = 'x' + xAxisIndex + 'y' + yAxisIndex;
                const cartesian = new Cartesian2D(key);

                cartesian.master = this;
                cartesian.model = gridModel;

                this._coordsMap[key] = cartesian;
                this._coordsList.push(cartesian);

                cartesian.addAxis(xAxis);
                cartesian.addAxis(yAxis);
            });
        });

        function createAxisCreator(dimName: Cartesian2DDimensionName) {
            return function (axisModel: CartesianAxisModel, idx: number): void {
                if (!isAxisUsedInTheGrid(axisModel, gridModel)) {
                    return;
                }

                let axisPosition = axisModel.get('position');
                if (dimName === 'x') {
                    // Fix position
                    if (axisPosition !== 'top' && axisPosition !== 'bottom') {
                        // Default bottom of X
                        axisPosition = axisPositionUsed.bottom ? 'top' : 'bottom';
                    }
                }
                else {
                    // Fix position
                    if (axisPosition !== 'left' && axisPosition !== 'right') {
                        // Default left of Y
                        axisPosition = axisPositionUsed.left ? 'right' : 'left';
                    }
                }
                axisPositionUsed[axisPosition] = true;

                const axis = new Axis2D(
                    dimName,
                    createScaleByModel(axisModel),
                    [0, 0],
                    axisModel.get('type'),
                    axisPosition
                );

                const isCategory = axis.type === 'category';
                axis.onBand = isCategory && (axisModel as AxisBaseModel<CategoryAxisBaseOption>).get('boundaryGap');
                axis.inverse = axisModel.get('inverse');

                // Inject axis into axisModel
                axisModel.axis = axis;

                // Inject axisModel into axis
                axis.model = axisModel;

                // Inject grid info axis
                axis.grid = grid;

                // Index of axis, can be used as key
                axis.index = idx;

                grid._axesList.push(axis);

                axesMap[dimName][idx] = axis;
                axesCount[dimName]++;
            };
        }
    }

    /**
     * Update cartesian properties from series.
     */
    private _updateScale(ecModel: GlobalModel, gridModel: GridModel): void {
        // Reset scale
        each(this._axesList, function (axis) {
            axis.scale.setExtent(Infinity, -Infinity);
            if (axis.type === 'category') {
                const categorySortInfo = axis.model.get('categorySortInfo');
                (axis.scale as OrdinalScale).setSortInfo(categorySortInfo);
            }
        });

        ecModel.eachSeries(function (seriesModel) {
            // If pie (or other similar series) use cartesian2d, the unionExtent logic below is
            // wrong, therefore skip it temporarily. See also in `defaultAxisExtentFromData.ts`.
            // TODO: support union extent in this case.
            if (isCartesian2DInjectedAsDataCoordSys(seriesModel)) {
                const axesModelMap = findAxisModels(seriesModel);
                const xAxisModel = axesModelMap.xAxisModel;
                const yAxisModel = axesModelMap.yAxisModel;

                if (!isAxisUsedInTheGrid(xAxisModel, gridModel)
                    || !isAxisUsedInTheGrid(yAxisModel, gridModel)
                ) {
                    return;
                }

                const cartesian = this.getCartesian(
                    xAxisModel.componentIndex, yAxisModel.componentIndex
                );
                const data = seriesModel.getData();
                const xAxis = cartesian.getAxis('x');
                const yAxis = cartesian.getAxis('y');

                unionExtent(data, xAxis);
                unionExtent(data, yAxis);
            }
        }, this);

        function unionExtent(data: SeriesData, axis: Axis2D): void {
            each(getDataDimensionsOnAxis(data, axis.dim), function (dim) {
                axis.scale.unionExtentFromData(data, dim);
            });
        }
    }

    /**
     * @param dim 'x' or 'y' or 'auto' or null/undefined
     */
    getTooltipAxes(dim: Cartesian2DDimensionName | 'auto'): {
        baseAxes: Axis2D[], otherAxes: Axis2D[]
    } {
        const baseAxes = [] as Axis2D[];
        const otherAxes = [] as Axis2D[];

        each(this.getCartesians(), function (cartesian) {
            const baseAxis = (dim != null && dim !== 'auto')
                ? cartesian.getAxis(dim) : cartesian.getBaseAxis();
            const otherAxis = cartesian.getOtherAxis(baseAxis);
            indexOf(baseAxes, baseAxis) < 0 && baseAxes.push(baseAxis);
            indexOf(otherAxes, otherAxis) < 0 && otherAxes.push(otherAxis);
        });

        return {baseAxes: baseAxes, otherAxes: otherAxes};
    }


    static create(ecModel: GlobalModel, api: ExtensionAPI): Grid[] {
        const grids = [] as Grid[];
        ecModel.eachComponent('grid', function (gridModel: GridModel, idx) {
            const grid = new Grid(gridModel, ecModel, api);
            grid.name = 'grid_' + idx;
            // dataSampling requires axis extent, so resize
            // should be performed in create stage.
            grid.resize(gridModel, api, true);

            gridModel.coordinateSystem = grid;

            grids.push(grid);
        });

        // Inject the coordinateSystems into seriesModel
        ecModel.eachSeries(function (seriesModel) {
            injectCoordSysByOption({
                targetModel: seriesModel,
                coordSysType: 'cartesian2d',
                coordSysProvider: coordSysProvider
            });

            function coordSysProvider() {
                const axesModelMap = findAxisModels(seriesModel);
                const xAxisModel = axesModelMap.xAxisModel;
                const yAxisModel = axesModelMap.yAxisModel;

                const gridModel = xAxisModel.getCoordSysModel();

                if (__DEV__) {
                    if (!gridModel) {
                        throw new Error(
                            'Grid "' + retrieve3(
                                xAxisModel.get('gridIndex'),
                                xAxisModel.get('gridId'),
                                0
                            ) + '" not found'
                        );
                    }
                    if (xAxisModel.getCoordSysModel() !== yAxisModel.getCoordSysModel()) {
                        throw new Error('xAxis and yAxis must use the same grid');
                    }
                }

                const grid = gridModel.coordinateSystem as Grid;

                return grid.getCartesian(
                    xAxisModel.componentIndex, yAxisModel.componentIndex
                );
            }
        });

        return grids;
    }

}

/**
 * Check if the axis is used in the specified grid.
 */
function isAxisUsedInTheGrid(axisModel: CartesianAxisModel, gridModel: GridModel): boolean {
    return axisModel.getCoordSysModel() === gridModel;
}

function fixAxisOnZero(
    axesMap: AxesMap,
    otherAxisDim: Cartesian2DDimensionName,
    axis: Axis2D,
    // Key: see `getOnZeroRecordKey`
    onZeroRecords: Dictionary<boolean>
): void {

    axis.getAxesOnZeroOf = function () {
        // TODO: onZero of multiple axes.
        return otherAxisOnZeroOf ? [otherAxisOnZeroOf] : [];
    };

    // onZero can not be enabled in these two situations:
    // 1. When any other axis is a category axis.
    // 2. When no axis is cross 0 point.
    const otherAxes = axesMap[otherAxisDim];

    let otherAxisOnZeroOf: Axis2D;
    const axisModel = axis.model;
    const onZero = axisModel.get(['axisLine', 'onZero']);
    const onZeroAxisIndex = axisModel.get(['axisLine', 'onZeroAxisIndex']);

    if (!onZero) {
        return;
    }

    // If target axis is specified.
    if (onZeroAxisIndex != null) {
        if (canOnZeroToAxis(otherAxes[onZeroAxisIndex])) {
            otherAxisOnZeroOf = otherAxes[onZeroAxisIndex];
        }
    }
    else {
        // Find the first available other axis.
        for (const idx in otherAxes) {
            if (otherAxes.hasOwnProperty(idx)
                && canOnZeroToAxis(otherAxes[idx])
                // Consider that two Y axes on one value axis,
                // if both onZero, the two Y axes overlap.
                && !onZeroRecords[getOnZeroRecordKey(otherAxes[idx])]
            ) {
                otherAxisOnZeroOf = otherAxes[idx];
                break;
            }
        }
    }

    if (otherAxisOnZeroOf) {
        onZeroRecords[getOnZeroRecordKey(otherAxisOnZeroOf)] = true;
    }

    function getOnZeroRecordKey(axis: Axis2D) {
        return axis.dim + '_' + axis.index;
    }
}

function canOnZeroToAxis(axis: Axis2D): boolean {
    return axis && axis.type !== 'category' && axis.type !== 'time' && ifAxisCrossZero(axis);
}

function updateAxisTransform(axis: Axis2D, coordBase: number) {
    const axisExtent = axis.getExtent();
    const axisExtentSum = axisExtent[0] + axisExtent[1];

    // Fast transform
    axis.toGlobalCoord = axis.dim === 'x'
        ? function (coord) {
            return coord + coordBase;
        }
        : function (coord) {
            return axisExtentSum - coord + coordBase;
        };
    axis.toLocalCoord = axis.dim === 'x'
        ? function (coord) {
            return coord - coordBase;
        }
        : function (coord) {
            return axisExtentSum - coord + coordBase;
        };
}

function updateAllAxisExtentTransByGridRect(axesMap: AxesMap, gridRect: LayoutRect) {
    each(axesMap.x, axis => updateAxisExtentTransByGridRect(axis, gridRect.x, gridRect.width));
    each(axesMap.y, axis => updateAxisExtentTransByGridRect(axis, gridRect.y, gridRect.height));
}

function updateAxisExtentTransByGridRect(axis: Axis2D, gridXY: number, gridWH: number): void {
    const extent = [0, gridWH];
    const idx = axis.inverse ? 1 : 0;
    axis.setExtent(extent[idx], extent[1 - idx]);
    updateAxisTransform(axis, gridXY);
}

export type LegacyLayOutGridByContainLabel = (axesList: Axis2D[], gridRect: LayoutRect) => void;
let legacyLayOutGridByContainLabel: LegacyLayOutGridByContainLabel | NullUndefined;
export function registerLegacyGridContainLabelImpl(impl: LegacyLayOutGridByContainLabel): void {
    legacyLayOutGridByContainLabel = impl;
}

// Return noPxChange.
function layOutGridByOuterBounds(
    outerBoundsRect: BoundingRect,
    outerBoundsContain: ParsedOuterBoundsContain,
    outerBoundsClamp: number[] | NullUndefined,
    gridRect: LayoutRect,
    axesMap: AxesMap,
    axisBuilderSharedCtx: AxisBuilderSharedContext,
    layoutRef: BoxLayoutReferenceResult,
    api: ExtensionAPI,
    grid: Grid,
    autoCompressSeries?: SeriesModel[]
): boolean {
    if (__DEV__) {
        assert(outerBoundsContain === 'all' || outerBoundsContain === 'axisLabel');
    }
    // Assume `updateAllAxisExtentTransByGridRect` has been performed once before this call.

    // [NOTE]:
    // - The bounding rect of the axis elements might be sensitve to variations in `axis.extent` due to strategies
    //  like hideOverlap/moveOverlap. @see the comment in `LabelLayoutBase['suggestIgnore']`.
    // - The final `gridRect` might be slightly smaller than the ideally expected result if labels are giant and
    //  get hidden due to overlapping. More iterations could improve precision, but not performant. We consider
    //  the current result acceptable, since no alignment among charts can be guaranteed when using this feature.
    createOrUpdateAxesView(
        gridRect,
        axesMap,
        AxisTickLabelComputingKind.estimate,
        outerBoundsContain,
        false,
        layoutRef
    );

    let margin = [0, 0, 0, 0];

    fillLabelNameOverflowOnOneDimension(0);
    fillLabelNameOverflowOnOneDimension(1);
    // If axis is blank, no label can be used to detect overflow.
    // gridRect itself should not overflow.
    fillMarginOnOneDimension(gridRect, 0, NaN);
    fillMarginOnOneDimension(gridRect, 1, NaN);

    const autoLayoutContext = grid.autoLayoutContext;
    let gridRectWithAxisLabels: LayoutRect;
    if (autoLayoutContext != null) {
        if (autoLayoutContext.needLayout) {
            const labelBoundingRects = calculateCartesianSeriesLabelBoundingRects(
                autoCompressSeries ?? collectCoordLabelSeries(api.getModel(), grid),
                api
            );
            gridRectWithAxisLabels = calculateGridRectWithAxisLabels(
                gridRect, axesMap, axisBuilderSharedCtx, labelBoundingRects
            );
            fillLegendGroupSpaceToMargin(
                autoLayoutContext.group,
                api,
                gridRectWithAxisLabels,
                margin,
                autoLayoutContext
            );
        }
        const contextMargin = autoLayoutContext.margin;
        if (autoLayoutContext.margin != null) {
            // 将计算好的margin应用到布局的margin中
            margin[0] += contextMargin[0]; // top
            margin[1] += contextMargin[1]; // right
            margin[2] += contextMargin[2]; // bottom
            margin[3] += contextMargin[3]; // left
        }
    }

    let noPxChange = find(margin, item => item > 0) == null;
    expandOrShrinkRect(gridRect, margin, true, true, outerBoundsClamp);
    gridRectWithAxisLabels && expandOrShrinkRect(gridRectWithAxisLabels, margin, true, true, outerBoundsClamp);
    updateAllAxisExtentTransByGridRect(axesMap, gridRect);

    // 需要在grid压缩完成后才能计算系列标签溢出，因为压缩会改变标签位置
    if (autoCompressSeries && autoCompressSeries.length > 0) {
        // 清空margin，重新计算系列标签溢出
        margin = [0, 0, 0, 0];
        const labelBoundingRects = calculateCartesianSeriesLabelBoundingRects(
            autoCompressSeries,
            api
        );
        fillSeriesLabelOverflowOnOneDimension(0, labelBoundingRects);
        fillSeriesLabelOverflowOnOneDimension(1, labelBoundingRects);
        if (find(margin, item => item > 0) != null) {
            noPxChange = false;
            expandOrShrinkRect(gridRect, margin, true, true, outerBoundsClamp);
            gridRectWithAxisLabels && expandOrShrinkRect(gridRectWithAxisLabels, margin, true, true, outerBoundsClamp);
            updateAllAxisExtentTransByGridRect(axesMap, gridRect);
        }
    }
    // 在 grid 布局完成后，基于最终的 gridRect 计算用于图例避让的矩形
    if (autoLayoutContext?.needLayout === true) {
        autoLayoutContext.finalBoundingRect = gridRectWithAxisLabels;
    }
    return noPxChange;

    function calculateGridRectWithAxisLabels(
        gridRect: LayoutRect,
        axesMap: AxesMap,
        axisBuilderSharedCtx: AxisBuilderSharedContext,
        labelBoundingRects?: Array<{
            rect: BoundingRect;
            textAlign: string;
        }>
    ): LayoutRect {
        // 使用通用的calculateRectWithAxisLabels方法
        const unionRect = calculateRectWithAxisLabels(
            gridRect, axesMap, axisBuilderSharedCtx
        );

        // 如果有系列标签边界矩形，进一步扩展矩形
        if (labelBoundingRects && labelBoundingRects.length > 0) {
            // 将标签边界矩形合并到最终矩形中
            const extendedRect = calculateOuterBoundingRectWithLabels(
                unionRect,
                labelBoundingRects
            );
            (extendedRect as LayoutRect).margin = gridRect.margin;
            return extendedRect as LayoutRect;
        }

        (unionRect as LayoutRect).margin = gridRect.margin;
        return unionRect as LayoutRect;
    }

    function fillLabelNameOverflowOnOneDimension(xyIdx: number): void {
        each(axesMap[XY[xyIdx]], axis => {
            if (!shouldAxisShow(axis.model)) {
                return;
            }
            // FIXME: zr Group.union may wrongly union (0, 0, 0, 0) and not performant.
            // unionRect.union(axis.axisBuilder.group.getBoundingRect());

            // If ussing Group.getBoundingRect to calculate shrink space, it is not strictly accurate when
            // the outermost label is ignored and the secondary label is very long and contribute to the
            // union extension:
            //      -|---|---|---|
            //         1,000,000,000
            // Therefore we calculate them one by one.
            // Also considered axis may be blank or no labels.
            const sharedRecord = axisBuilderSharedCtx.ensureRecord(axis.model);
            const labelInfoList = sharedRecord.labelInfoList;
            if (labelInfoList) {
                for (let idx = 0; idx < labelInfoList.length; idx++) {
                    const labelInfo = labelInfoList[idx];
                    let proportion = axis.scale.normalize(getLabelInner(labelInfo.label).tickValue);
                    proportion = xyIdx === 1 ? 1 - proportion : proportion;
                    // xAxis use proportion on x, yAxis use proprotion on y, otherwise not.
                    fillMarginOnOneDimension(labelInfo.rect, xyIdx, proportion);
                    fillMarginOnOneDimension(labelInfo.rect, 1 - xyIdx, NaN);
                }
            }
            const nameLayout = sharedRecord.nameLayout;
            if (nameLayout) {
                const proportion = isNameLocationCenter(sharedRecord.nameLocation) ? 0.5 : NaN;
                fillMarginOnOneDimension(nameLayout.rect, xyIdx, proportion);
                fillMarginOnOneDimension(nameLayout.rect, 1 - xyIdx, NaN);
            }
        });
    }

    function fillMarginOnOneDimension(
        itemRect: BoundingRect,
        xyIdx: number,
        proportion: number // NaN mean no use proportion
    ): void {
        let overflow1 = outerBoundsRect[XY[xyIdx]] - itemRect[XY[xyIdx]];
        let overflow2 = (itemRect[WH[xyIdx]] + itemRect[XY[xyIdx]])
            - (outerBoundsRect[WH[xyIdx]] + outerBoundsRect[XY[xyIdx]]);
        overflow1 = applyProportion(overflow1, 1 - proportion);
        overflow2 = applyProportion(overflow2, proportion);
        const minIdx = XY_TO_MARGIN_IDX[xyIdx][0];
        const maxIdx = XY_TO_MARGIN_IDX[xyIdx][1];
        margin[minIdx] = mathMax(margin[minIdx], overflow1);
        margin[maxIdx] = mathMax(margin[maxIdx], overflow2);
    }

    /**
     * 针对系列标签（如 markPoint/markLine 之类），计算其超出坐标系边界的部分，并尝试相应地扩大坐标系的边界留白。
     *
     * @param xyIdx 当前维度索引（0 表示 x 轴，1 表示 y 轴）。
     * @param labelBoundingRects 已提前计算好的标签包围盒列表，其中已包含 label 的排版和旋转等信息。
     */
    function fillSeriesLabelOverflowOnOneDimension(
        xyIdx: number,
        labelBoundingRects: Array<{
            rect: BoundingRect;
            textAlign: string;
        }>
    ): void {
        // 遍历每一个由 autoLayout 返回的标签包围盒
        each(labelBoundingRects, function (labelInfo) {
            const positionedRect = labelInfo.rect;
            // 对当前维度和正交维分别考虑标签溢出；proportion 设为 NaN 表示不缩放而是直接扩展即可
            // 这样做可以涵盖多种 textAlign 和标签旋转情况，确保标签始终可见
            fillMarginOnOneDimension(positionedRect, xyIdx, NaN);
            fillMarginOnOneDimension(positionedRect, 1 - xyIdx, NaN);
        });
    }

    function applyProportion(overflow: number, proportion: number): number {
        // proportion is not likely to near zero. If so, give up shrink
        if (overflow > 0 && !eqNaN(proportion) && proportion > 1e-4) {
            overflow /= proportion;
        }
        return overflow;
    }
}

function createAxisBiulders(
    gridRect: LayoutRect,
    cartesians: Cartesian2D[],
    axesMap: AxesMap,
    optionContainLabel: GridOption['containLabel'],
    api: ExtensionAPI,
): AxisBuilderSharedContext {
    const axisBuilderSharedCtx = new AxisBuilderSharedContext(resolveAxisNameOverlapForGrid);
    each(axesMap, axisList => each(axisList, axis => {
        if (shouldAxisShow(axis.model)) {
            // See `AxisBaseOptionCommon['nameMoveOverlap']`.
            const defaultNameMoveOverlap = !optionContainLabel;
            axis.axisBuilder = createCartesianAxisViewCommonPartBuilder(
                gridRect, cartesians, axis.model, api, axisBuilderSharedCtx, defaultNameMoveOverlap
            );
        }
    }));
    return axisBuilderSharedCtx;
}

/**
 * Promote the axis-elements-building from "view render" stage to "coordinate system resize" stage.
 * This is aimed to resovle overlap across multiple axes, since currently it's hard to reconcile
 * multiple axes in "view render" stage.
 *
 * [CAUTION] But this promotion assumes that the subsequent "visual mapping" stage does not affect
 * this axis-elements-building; otherwise we have to refactor it again.
 */
function createOrUpdateAxesView(
    gridRect: LayoutRect,
    axesMap: AxesMap,
    kind: AxisTickLabelComputingKind,
    outerBoundsContain: ParsedOuterBoundsContain | NullUndefined,
    noPxChange: boolean,
    layoutRef: BoxLayoutReferenceResult
): void {
    const isDetermine = kind === AxisTickLabelComputingKind.determine;
    each(axesMap, axisList => each(axisList, axis => {
        if (shouldAxisShow(axis.model)) {
            updateCartesianAxisViewCommonPartBuilder(axis.axisBuilder, gridRect, axis.model);
            axis.axisBuilder.build(
                isDetermine
                    ? {axisTickLabelDetermine: true}
                    : {axisTickLabelEstimate: true},
                {noPxChange}
            );
        }
    }));

    const nameMarginLevelMap = {x: 0, y: 0};
    calcNameMarginLevel(0);
    calcNameMarginLevel(1);
    function calcNameMarginLevel(xyIdx: number): void {
        nameMarginLevelMap[XY[1 - xyIdx]] = gridRect[WH[xyIdx]] <= layoutRef.refContainer[WH[xyIdx]] * 0.5
            ? 0 : ((1 - xyIdx) === 1 ? 2 : 1);
    }

    each(axesMap, (axisList, xy) => each(axisList, axis => {
        if (shouldAxisShow(axis.model)) {
            if (outerBoundsContain === 'all' || isDetermine) {
                // To resolve overlap, `axisName` layout depends on `axisTickLabel` layout result
                // (all of the axes of the same `grid`; consider multiple x or y axes).
                axis.axisBuilder.build({axisName: true}, {nameMarginLevel: nameMarginLevelMap[xy]});
            }
            if (isDetermine) {
                axis.axisBuilder.build({axisLine: true});
            }
        }
    }));
}

function prepareOuterBounds(
    gridModel: GridModel,
    rawRridRect: BoundingRect,
    layoutRef: BoxLayoutReferenceResult,
): {
    outerBoundsRect: BoundingRect | NullUndefined
    parsedOuterBoundsContain: ParsedOuterBoundsContain
    outerBoundsClamp: number[]
} {
    let outerBoundsRect: BoundingRect | NullUndefined;
    const optionOuterBoundsMode = gridModel.get('outerBoundsMode', true);
    if (optionOuterBoundsMode === 'same') {
        outerBoundsRect = rawRridRect.clone();
    }
    else if (optionOuterBoundsMode == null || optionOuterBoundsMode === 'auto') {
        outerBoundsRect = getLayoutRect(
            gridModel.get('outerBounds', true) || OUTER_BOUNDS_DEFAULT, layoutRef.refContainer
        );
    }
    else if (optionOuterBoundsMode !== 'none') {
        if (__DEV__) {
            error(`Invalid grid[${gridModel.componentIndex}].outerBoundsMode.`);
        }
    }

    const optionOuterBoundsContain = gridModel.get('outerBoundsContain', true);
    let parsedOuterBoundsContain: ParsedOuterBoundsContain;
    if (optionOuterBoundsContain == null || optionOuterBoundsContain === 'auto') {
        parsedOuterBoundsContain = 'all';
    }
    else if (indexOf(['all', 'axisLabel'], optionOuterBoundsContain) < 0) {
        if (__DEV__) {
            error(`Invalid grid[${gridModel.componentIndex}].outerBoundsContain.`);
        }
        parsedOuterBoundsContain = 'all';
    }
    else {
        parsedOuterBoundsContain = optionOuterBoundsContain;
    }

    const outerBoundsClamp = [
        parsePositionSizeOption(
            retrieve2(gridModel.get('outerBoundsClampWidth', true), OUTER_BOUNDS_CLAMP_DEFAULT[0]), rawRridRect.width
        ),
        parsePositionSizeOption(
            retrieve2(gridModel.get('outerBoundsClampHeight', true), OUTER_BOUNDS_CLAMP_DEFAULT[1]), rawRridRect.height
        )
    ];

    return {outerBoundsRect, parsedOuterBoundsContain, outerBoundsClamp};
}

const resolveAxisNameOverlapForGrid: AxisBuilderSharedContext['resolveAxisNameOverlap'] = (
    cfg, ctx, axisModel, nameLayoutInfo, nameMoveDirVec, thisRecord
) => {
    const perpendicularDim = axisModel.axis.dim === 'x' ? 'y' : 'x';

    resolveAxisNameOverlapDefault(cfg, ctx, axisModel, nameLayoutInfo, nameMoveDirVec, thisRecord);

    // If nameLocation 'center', and there are multiple axes parallel to this axis, do not adjust by
    //  other axes, because the axis name should be close to its axis line as much as possible even
    //  if overlapping; otherwise it might cause misleading.
    // If nameLocation 'center', do not adjust by perpendicular axes, since they are not likely to overlap.
    // If nameLocation 'start'/'end', move name within the same direction to escape overlap with the
    //  perpendicular axes.
    if (!isNameLocationCenter(cfg.nameLocation)) {
        each(ctx.recordMap[perpendicularDim], perpenRecord => {
            // perpendicular axis may be no name.
            if (perpenRecord && perpenRecord.labelInfoList && perpenRecord.dirVec) {
                moveIfOverlapByLinearLabels(
                    perpenRecord.labelInfoList, perpenRecord.dirVec, nameLayoutInfo, nameMoveDirVec
                );
            }
        });
    }
};

/**
 * 计算笛卡尔坐标系系列标签边界矩形。
 *
 * @param seriesModels 系列模型列表
 * @param api ExtensionAPI 实例
 * @returns 标签边界矩形和对齐信息列表
 */
function calculateCartesianSeriesLabelBoundingRects(
    seriesModels: SeriesModel[],
    api: ExtensionAPI
): Array<{
    rect: BoundingRect;
    textAlign: string;
}> {
    return calculateSeriesLabelBoundingRects(
        seriesModels,
        api,
        (seriesModel, data) => {
            // 获取当前系列所使用的笛卡尔坐标系对象，后续用于将 x/y 数据值映射为像素坐标
            const cartesian = seriesModel.coordinateSystem as any; // Cartesian2D

            // items 用于收集每个数据点的标签边界和相关信息
            const items: Array<{
                dataIndex: number;
                point: number[];
                symbolRect: BoundingRect;
                labelText: string;
            }> = [];

            // 遍历每个数据点，逐一处理
            data.each(function (idx: number) {
                // 获取数据点的 x/y 值。如果缺失，说明该点无效，直接跳过。
                const dataValue = data.getValues(['x', 'y'], idx);
                if (dataValue[0] == null || dataValue[1] == null) {
                    return;
                }

                // 将原始的 x/y 数据值通过笛卡尔系映射到像素坐标。若返回无效坐标则跳过。
                const point = cartesian.dataToPoint(dataValue);
                if (!point || point.length < 2) {
                    // 可能由于数据越界或坐标系未初始化等原因导致映射失败，需跳过
                    return;
                }

                // 获取当前数据点的标签文本内容（如显示值、分类名等）。
                // 若未配置显示或内容为空，则该点无需生成标签边界。
                const labelText = seriesModel.getFormattedLabel(idx, 'normal');
                if (labelText == null || labelText === '') {
                    return;
                }

                // 统一调用工具函数计算该数据点的标记符号的像素边界矩形（考虑不同 symbol 类型/大小等）
                // symbolRect 将用于后续判断标签和图形的排布、碰撞等
                const symbolRect = calculateSymbolRect(seriesModel, data, idx, point, api);
                if (!symbolRect) {
                    // 防御性判断，某些极端情况可能无法获得正常的矩形
                    return;
                }

                // 收集当前数据点的标签/图形显示必要信息，用于最终统一布局与碰撞检测
                items.push({
                    dataIndex: idx,
                    point: point,
                    symbolRect: symbolRect,
                    labelText: labelText
                });
            });

            // 返回当前系列中所有有效数据点的信息，供后续批量计算标签布局用
            return items;
        }
    );
}

export default Grid;
