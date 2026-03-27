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

import { each, defaults, keys } from 'zrender/src/core/util';
import { parsePercent } from '../util/number';
import { isDimensionStacked } from '../data/helper/dataStackHelper';
import createRenderPlanner from '../chart/helper/createRenderPlanner';
import BarSeriesModel from '../chart/bar/BarSeries';
import Axis2D from '../coord/cartesian/Axis2D';
import GlobalModel from '../model/Global';
import type Cartesian2D from '../coord/cartesian/Cartesian2D';
import { StageHandler, Dictionary } from '../util/types';
import { createFloat32Array } from '../util/vendor';
import SeriesData from '../data/SeriesData';
import DataStore from '../data/DataStore';

const STACK_PREFIX = '__ec_stack_';

function getSeriesStackId(seriesModel: BarSeriesModel): string {
    return seriesModel.get('stack') || STACK_PREFIX + seriesModel.seriesIndex;
}

function getAxisKey(axis: Axis2D): string {
    return axis.dim + axis.index;
}

interface LayoutSeriesInfo {
    bandWidth: number
    barWidth: number
    barMaxWidth: number
    barMinWidth: number
    barGap: number | string
    defaultBarGap?: number | string
    barCategoryGap: number | string
    axisKey: string
    stackId: string
}

interface StackInfo {
    width: number
    maxWidth: number
    minWidth?: number
}

/**
 * {
 *  [coordSysId]: {
 *      [stackId]: {bandWidth, offset, width}
 *  }
 * }
 */
type BarWidthAndOffset = Dictionary<Dictionary<{
    bandWidth: number
    offset: number
    offsetCenter: number
    width: number
}>>;

export interface BarGridLayoutOptionForCustomSeries {
    count: number

    barWidth?: number | string
    barMaxWidth?: number | string
    barMinWidth?: number | string
    barGap?: number | string
    barCategoryGap?: number | string
}
interface LayoutOption extends BarGridLayoutOptionForCustomSeries {
    axis: Axis2D
}

export type BarGridLayoutResult = BarWidthAndOffset[string][string][];
/**
 * @return {Object} {width, offset, offsetCenter} If axis.type is not 'category', return undefined.
 */
export function getLayoutOnAxis(opt: LayoutOption): BarGridLayoutResult {
    const params: LayoutSeriesInfo[] = [];
    const baseAxis = opt.axis;
    const axisKey = 'axis0';

    if (baseAxis.type !== 'category') {
        return;
    }
    const bandWidth = baseAxis.getBandWidth();

    for (let i = 0; i < opt.count || 0; i++) {
        params.push(defaults({
            bandWidth: bandWidth,
            axisKey: axisKey,
            stackId: STACK_PREFIX + i
        }, opt) as LayoutSeriesInfo);
    }
    const widthAndOffsets = doCalBarWidthAndOffset(params);

    const result = [];
    for (let i = 0; i < opt.count; i++) {
        const item = widthAndOffsets[axisKey][STACK_PREFIX + i];
        item.offsetCenter = item.offset + item.width / 2;
        result.push(item);
    }

    return result;
}

export function prepareLayoutBarSeries(seriesType: string, ecModel: GlobalModel): BarSeriesModel[] {
    const seriesModels: BarSeriesModel[] = [];
    ecModel.eachSeriesByType(seriesType, function (seriesModel: BarSeriesModel) {
        // Check series coordinate, do layout for cartesian2d only
        if (isOnCartesian(seriesModel)) {
            seriesModels.push(seriesModel);
        }
    });
    return seriesModels;
}


/**
 * Map from (baseAxis.dim + '_' + baseAxis.index) to min gap of two adjacent
 * values.
 * This works for time axes, value axes, and log axes.
 * For a single time axis, return value is in the form like
 * {'x_0': [1000000]}.
 * The value of 1000000 is in milliseconds.
 */
function getValueAxesMinGaps(barSeries: BarSeriesModel[]) {
    /**
     * Map from axis.index to values.
     * For a single time axis, axisValues is in the form like
     * {'x_0': [1495555200000, 1495641600000, 1495728000000]}.
     * Items in axisValues[x], e.g. 1495555200000, are time values of all
     * series.
     */
    const axisValues: Dictionary<number[]> = {};
    each(barSeries, function (seriesModel) {
        const cartesian = seriesModel.coordinateSystem as Cartesian2D;
        const baseAxis = cartesian.getBaseAxis();
        if (baseAxis.type !== 'time' && baseAxis.type !== 'value') {
            return;
        }

        const data = seriesModel.getData();
        const key = baseAxis.dim + '_' + baseAxis.index;
        const dimIdx = data.getDimensionIndex(data.mapDimension(baseAxis.dim));
        const store = data.getStore();
        for (let i = 0, cnt = store.count(); i < cnt; ++i) {
            const value = store.get(dimIdx, i) as number;
            if (!axisValues[key]) {
                // No previous data for the axis
                axisValues[key] = [value];
            }
            else {
                // No value in previous series
                axisValues[key].push(value);
            }
            // Ignore duplicated time values in the same axis
        }
    });

    const axisMinGaps: Dictionary<number> = {};
    for (const key in axisValues) {
        if (axisValues.hasOwnProperty(key)) {
            const valuesInAxis = axisValues[key];
            if (valuesInAxis) {
                // Sort axis values into ascending order to calculate gaps
                valuesInAxis.sort(function (a, b) {
                    return a - b;
                });

                let min = null;
                for (let j = 1; j < valuesInAxis.length; ++j) {
                    const delta = valuesInAxis[j] - valuesInAxis[j - 1];
                    if (delta > 0) {
                        // Ignore 0 delta because they are of the same axis value
                        min = min === null ? delta : Math.min(min, delta);
                    }
                }
                // Set to null if only have one data
                axisMinGaps[key] = min;
            }
        }
    }
    return axisMinGaps;
}

export function makeColumnLayout(barSeries: BarSeriesModel[]) {
    const axisMinGaps = getValueAxesMinGaps(barSeries);

    const seriesInfoList: LayoutSeriesInfo[] = [];
    each(barSeries, function (seriesModel) {
        const cartesian = seriesModel.coordinateSystem as Cartesian2D;
        const baseAxis = cartesian.getBaseAxis();
        const axisExtent = baseAxis.getExtent();

        let bandWidth;
        if (baseAxis.type === 'category') {
            bandWidth = baseAxis.getBandWidth();
        }
        else if (baseAxis.type === 'value' || baseAxis.type === 'time') {
            const key = baseAxis.dim + '_' + baseAxis.index;
            const minGap = axisMinGaps[key];
            const extentSpan = Math.abs(axisExtent[1] - axisExtent[0]);
            const scale = baseAxis.scale.getExtent();
            const scaleSpan = Math.abs(scale[1] - scale[0]);
            bandWidth = minGap
                ? extentSpan / scaleSpan * minGap
                : extentSpan; // When there is only one data value
        }
        else {
            const data = seriesModel.getData();
            bandWidth = Math.abs(axisExtent[1] - axisExtent[0]) / data.count();
        }

        const barWidth = parsePercent(
            seriesModel.get('barWidth'), bandWidth
        );
        const barMaxWidth = parsePercent(
            seriesModel.get('barMaxWidth'), bandWidth
        );
        const barMinWidth = parsePercent(
            // barMinWidth by default is 0.5 / 1 in cartesian. Because in value axis,
            // the auto-calculated bar width might be less than 0.5 / 1.
            seriesModel.get('barMinWidth') || (isInLargeMode(seriesModel) ? 0.5 : 1), bandWidth
        );
        const barGap = seriesModel.get('barGap');
        const barCategoryGap = seriesModel.get('barCategoryGap');
        const defaultBarGap = seriesModel.get('defaultBarGap');

        seriesInfoList.push({
            bandWidth: bandWidth,
            barWidth: barWidth,
            barMaxWidth: barMaxWidth,
            barMinWidth: barMinWidth,
            barGap: barGap,
            barCategoryGap: barCategoryGap,
            defaultBarGap: defaultBarGap,
            axisKey: getAxisKey(baseAxis),
            stackId: getSeriesStackId(seriesModel)
        });
    });

    return doCalBarWidthAndOffset(seriesInfoList);
}

function doCalBarWidthAndOffset(seriesInfoList: LayoutSeriesInfo[]) {
    interface ColumnOnAxisInfo {
        bandWidth: number
        remainedWidth: number
        autoWidthCount: number
        categoryGap: number | string
        gap: number | string
        stacks: Dictionary<StackInfo>
    }

    // Columns info on each category axis. Key is cartesian name
    const columnsMap: Dictionary<ColumnOnAxisInfo> = {};

    each(seriesInfoList, function (seriesInfo, idx) {
        const axisKey = seriesInfo.axisKey;
        const bandWidth = seriesInfo.bandWidth;
        const columnsOnAxis: ColumnOnAxisInfo = columnsMap[axisKey] || {
            bandWidth: bandWidth,
            remainedWidth: bandWidth,
            autoWidthCount: 0,
            categoryGap: null,
            gap: seriesInfo.defaultBarGap || 0,
            stacks: {}
        };
        const stacks = columnsOnAxis.stacks;
        columnsMap[axisKey] = columnsOnAxis;

        const stackId = seriesInfo.stackId;

        if (!stacks[stackId]) {
            columnsOnAxis.autoWidthCount++;
        }
        stacks[stackId] = stacks[stackId] || {
            width: 0,
            maxWidth: 0
        };

        // Caution: In a single coordinate system, these barGrid attributes
        // will be shared by series. Consider that they have default values,
        // only the attributes set on the last series will work.
        // Do not change this fact unless there will be a break change.

        let barWidth = seriesInfo.barWidth;
        if (barWidth && !stacks[stackId].width) {
            // See #6312, do not restrict width.
            stacks[stackId].width = barWidth;
            barWidth = Math.min(columnsOnAxis.remainedWidth, barWidth);
            columnsOnAxis.remainedWidth -= barWidth;
        }

        const barMaxWidth = seriesInfo.barMaxWidth;
        barMaxWidth && (stacks[stackId].maxWidth = barMaxWidth);
        const barMinWidth = seriesInfo.barMinWidth;
        barMinWidth && (stacks[stackId].minWidth = barMinWidth);
        const barGap = seriesInfo.barGap;
        (barGap != null) && (columnsOnAxis.gap = barGap);
        const barCategoryGap = seriesInfo.barCategoryGap;
        (barCategoryGap != null) && (columnsOnAxis.categoryGap = barCategoryGap);
    });

    const result: BarWidthAndOffset = {};

    each(columnsMap, function (columnsOnAxis, coordSysName) {

        result[coordSysName] = {};

        const stacks = columnsOnAxis.stacks;
        const bandWidth = columnsOnAxis.bandWidth;
        let categoryGapPercent = columnsOnAxis.categoryGap;
        if (categoryGapPercent == null) {
            const columnCount = keys(stacks).length;
            // More columns in one group
            // the spaces between group is smaller. Or the column will be too thin.
            categoryGapPercent = Math.max((35 - columnCount * 4), 15) + '%';
        }

        const categoryGap = parsePercent(categoryGapPercent, bandWidth);
        const barGapPercent = parsePercent(columnsOnAxis.gap, 1);

        let remainedWidth = columnsOnAxis.remainedWidth;
        let autoWidthCount = columnsOnAxis.autoWidthCount;
        let autoWidth = (remainedWidth - categoryGap)
            / (autoWidthCount + (autoWidthCount - 1) * barGapPercent);
        autoWidth = Math.max(autoWidth, 0);

        // Find if any auto calculated bar exceeded maxBarWidth
        each(stacks, function (column) {
            const maxWidth = column.maxWidth;
            const minWidth = column.minWidth;

            if (!column.width) {
                let finalWidth = autoWidth;
                if (maxWidth && maxWidth < finalWidth) {
                    finalWidth = Math.min(maxWidth, remainedWidth);
                }
                // `minWidth` has higher priority. `minWidth` decide that whether the
                // bar is able to be visible. So `minWidth` should not be restricted
                // by `maxWidth` or `remainedWidth` (which is from `bandWidth`). In
                // the extreme cases for `value` axis, bars are allowed to overlap
                // with each other if `minWidth` specified.
                if (minWidth && minWidth > finalWidth) {
                    finalWidth = minWidth;
                }
                if (finalWidth !== autoWidth) {
                    column.width = finalWidth;
                    remainedWidth -= finalWidth + barGapPercent * finalWidth;
                    autoWidthCount--;
                }
            }
            else {
                // `barMinWidth/barMaxWidth` has higher priority than `barWidth`, as
                // CSS does. Because barWidth can be a percent value, where
                // `barMaxWidth` can be used to restrict the final width.
                let finalWidth = column.width;
                if (maxWidth) {
                    finalWidth = Math.min(finalWidth, maxWidth);
                }
                // `minWidth` has higher priority, as described above
                if (minWidth) {
                    finalWidth = Math.max(finalWidth, minWidth);
                }
                column.width = finalWidth;
                remainedWidth -= finalWidth + barGapPercent * finalWidth;
                autoWidthCount--;
            }
        });

        // Recalculate width again
        autoWidth = (remainedWidth - categoryGap)
            / (autoWidthCount + (autoWidthCount - 1) * barGapPercent);

        autoWidth = Math.max(autoWidth, 0);


        let widthSum = 0;
        let lastColumn: StackInfo;
        each(stacks, function (column, idx) {
            if (!column.width) {
                column.width = autoWidth;
            }
            lastColumn = column;
            widthSum += column.width * (1 + barGapPercent);
        });
        if (lastColumn) {
            widthSum -= lastColumn.width * barGapPercent;
        }

        let offset = -widthSum / 2;
        each(stacks, function (column, stackId) {
            result[coordSysName][stackId] = result[coordSysName][stackId] || {
                bandWidth: bandWidth,
                offset: offset,
                width: column.width
            } as BarWidthAndOffset[string][string];

            offset += column.width * (1 + barGapPercent);
        });
    });

    return result;
}

/**
 * @param barWidthAndOffset The result of makeColumnLayout
 * @param seriesModel If not provided, return all.
 * @return {stackId: {offset, width}} or {offset, width} if seriesModel provided.
 */
function retrieveColumnLayout(barWidthAndOffset: BarWidthAndOffset, axis: Axis2D): typeof barWidthAndOffset[string];
// eslint-disable-next-line max-len
function retrieveColumnLayout(barWidthAndOffset: BarWidthAndOffset, axis: Axis2D, seriesModel: BarSeriesModel): typeof barWidthAndOffset[string][string];
function retrieveColumnLayout(
    barWidthAndOffset: BarWidthAndOffset,
    axis: Axis2D,
    seriesModel?: BarSeriesModel
) {
    if (barWidthAndOffset && axis) {
        const result = barWidthAndOffset[getAxisKey(axis)];
        if (result != null && seriesModel != null) {
            return result[getSeriesStackId(seriesModel)];
        }
        return result;
    }
}
export {retrieveColumnLayout};

export interface BarLayoutResult {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface BarLayoutContext {
    cartesian: Cartesian2D;
    baseAxis: Axis2D;
    valueAxis: Axis2D;
    valueDimIdx: number;
    baseDimIdx: number;
    stackedDimIdx: number | null;
    stacked: boolean;
    isValueAxisH: boolean;
    barMinHeight: number;
    valueAxisStart: number;
    columnWidth: number;
    columnOffset: number;
    store: DataStore;
}

export interface BarDataValues {
    value: number;
    baseValue: number;
    stackStartValue: number | undefined;
}

/**
 * Prepare the layout context for bar chart calculation.
 * This function extracts common setup logic shared by BarView and createProgressiveLayout.
 */
export function prepareBarLayoutContext(
    seriesModel: BarSeriesModel,
    data: SeriesData,
    checkLayoutParams?: boolean
): BarLayoutContext | null {
    const cartesian = seriesModel.coordinateSystem as Cartesian2D;
    if (!cartesian) {
        return null;
    }

    const baseAxis = cartesian.getBaseAxis();
    const valueAxis = cartesian.getOtherAxis(baseAxis);
    const valueDimIdx = data.getDimensionIndex(data.mapDimension(valueAxis.dim));
    const baseDimIdx = data.getDimensionIndex(data.mapDimension(baseAxis.dim));
    const valueDim = data.mapDimension(valueAxis.dim);
    const stackResultDim = data.getCalculationInfo('stackResultDimension');
    const stacked = isDimensionStacked(data, valueDim) && !!data.getCalculationInfo('stackedOnSeries');
    const isValueAxisH = valueAxis.isHorizontal();
    const barMinHeight = seriesModel.get('barMinHeight') || 0;
    const stackedDimIdx = stackResultDim ? data.getDimensionIndex(stackResultDim) : null;
    const valueAxisStart = getValueAxisStart(baseAxis, valueAxis);

    // Layout info.
    const columnWidth = data.getLayout('size');
    const columnOffset = data.getLayout('offset');

    // If checkLayoutParams is true, validate layout parameters (used by BarView)
    if (checkLayoutParams && (columnWidth == null || columnOffset == null)) {
        return null;
    }

    const store = data.getStore();

    return {
        cartesian,
        baseAxis,
        valueAxis,
        valueDimIdx,
        baseDimIdx,
        stackedDimIdx,
        stacked,
        isValueAxisH,
        barMinHeight,
        valueAxisStart,
        columnWidth: columnWidth as number,
        columnOffset: columnOffset as number,
        store
    };
}

/**
 * Get data values (value, baseValue, stackStartValue) for a specific data index.
 * This function extracts common data retrieval logic shared by BarView and createProgressiveLayout.
 */
export function getBarDataValues(
    context: BarLayoutContext,
    dataIndex: number
): BarDataValues {
    const { store, stacked, stackedDimIdx, valueDimIdx, baseDimIdx } = context;

    const value = store.get(stacked && stackedDimIdx != null ? stackedDimIdx : valueDimIdx, dataIndex) as number;
    const baseValue = store.get(baseDimIdx, dataIndex) as number;

    let stackStartValue: number | undefined;
    // Because of the barMinHeight, we can not use the value in
    // stackResultDimension directly.
    if (stacked) {
        stackStartValue = +value - (store.get(valueDimIdx, dataIndex) as number);
    }

    return {
        value,
        baseValue,
        stackStartValue
    };
}

/**
 * Calculate the layout (x, y, width, height) for a single bar.
 * This function is shared by both BarView and createProgressiveLayout.
 */
export function calculateBarLayout(
    context: BarLayoutContext,
    dataValues: BarDataValues
): BarLayoutResult {
    const {
        cartesian,
        valueAxisStart,
        columnWidth,
        columnOffset,
        stacked,
        isValueAxisH,
        barMinHeight
    } = context;
    const {
        value,
        baseValue,
        stackStartValue
    } = dataValues;

    let baseCoord = valueAxisStart;

    // Because of the barMinHeight, we can not use the value in
    // stackResultDimension directly.
    if (stacked && stackStartValue != null) {
        const startCoord = isValueAxisH
            ? cartesian.dataToPoint([stackStartValue, baseValue])
            : cartesian.dataToPoint([baseValue, stackStartValue]);
        baseCoord = isValueAxisH ? startCoord[0] : startCoord[1];
    }

    let x: number;
    let y: number;
    let width: number;
    let height: number;

    if (isValueAxisH) {
        const coord = cartesian.dataToPoint([value, baseValue]);
        x = baseCoord;
        y = coord[1] + columnOffset;
        width = coord[0] - baseCoord;
        height = columnWidth;

        if (Math.abs(width) < barMinHeight) {
            width = (width < 0 ? -1 : 1) * barMinHeight;
        }
    }
    else {
        const coord = cartesian.dataToPoint([baseValue, value]);
        x = coord[0] + columnOffset;
        y = baseCoord;
        width = columnWidth;
        height = coord[1] - baseCoord;

        if (Math.abs(height) < barMinHeight) {
            // Include zero to has a positive bar
            height = (height <= 0 ? -1 : 1) * barMinHeight;
        }
    }

    return { x, y, width, height };
}

export function layout(seriesType: string, ecModel: GlobalModel) {

    const seriesModels = prepareLayoutBarSeries(seriesType, ecModel);
    const barWidthAndOffset = makeColumnLayout(seriesModels);

    each(seriesModels, function (seriesModel) {

        const data = seriesModel.getData();
        const cartesian = seriesModel.coordinateSystem as Cartesian2D;
        const baseAxis = cartesian.getBaseAxis();

        const stackId = getSeriesStackId(seriesModel);
        const columnLayoutInfo = barWidthAndOffset[getAxisKey(baseAxis)][stackId];
        const columnOffset = columnLayoutInfo.offset;
        const columnWidth = columnLayoutInfo.width;

        data.setLayout({
            bandWidth: columnLayoutInfo.bandWidth,
            offset: columnOffset,
            size: columnWidth
        });
    });
}

// TODO: Do not support stack in large mode yet.
export function createProgressiveLayout(seriesType: string): StageHandler {
    return {
        seriesType,

        plan: createRenderPlanner(),

        reset: function (seriesModel: BarSeriesModel) {
            if (!isOnCartesian(seriesModel)) {
                return;
            }

            const data = seriesModel.getData();
            const layoutContext = prepareBarLayoutContext(seriesModel, data);
            if (!layoutContext) {
                return;
            }

            const drawBackground = seriesModel.get('showBackground', true);
            const isLarge = isInLargeMode(seriesModel);

            return {
                progress: function (params, data) {
                    const count = params.count;
                    const largePoints = isLarge && createFloat32Array(count * 3);
                    const largeBackgroundPoints = isLarge && drawBackground && createFloat32Array(count * 3);
                    const largeDataIndices = isLarge && createFloat32Array(count);
                    const coordLayout = layoutContext.cartesian.master.getRect();
                    const bgSize = layoutContext.isValueAxisH ? coordLayout.width : coordLayout.height;

                    let dataIndex;
                    let idxOffset = 0;

                    while ((dataIndex = params.next()) != null) {
                        const dataValues = getBarDataValues(layoutContext, dataIndex);

                        const layout = calculateBarLayout(layoutContext, dataValues);

                        const { x, y, width, height } = layout;

                        if (!isLarge) {
                            data.setItemLayout(dataIndex, { x, y, width, height });
                        }
                        else {
                            largePoints[idxOffset] = x;
                            largePoints[idxOffset + 1] = y;
                            largePoints[idxOffset + 2] = layoutContext.isValueAxisH ? width : height;

                            if (largeBackgroundPoints) {
                                largeBackgroundPoints[idxOffset] = layoutContext.isValueAxisH ? coordLayout.x : x;
                                largeBackgroundPoints[idxOffset + 1] = layoutContext.isValueAxisH ? y : coordLayout.y;
                                largeBackgroundPoints[idxOffset + 2] = bgSize;
                            }

                            largeDataIndices[dataIndex] = dataIndex;
                        }

                        idxOffset += 3;
                    }

                    if (isLarge) {
                        data.setLayout({
                            largePoints,
                            largeDataIndices,
                            largeBackgroundPoints,
                            valueAxisHorizontal: layoutContext.isValueAxisH
                        });
                    }
                }
            };
        }
    };
}

function isOnCartesian(seriesModel: BarSeriesModel) {
    return seriesModel.coordinateSystem && seriesModel.coordinateSystem.type === 'cartesian2d';
}

function isInLargeMode(seriesModel: BarSeriesModel) {
    return seriesModel.pipelineContext && seriesModel.pipelineContext.large;
}

// See cases in `test/bar-start.html` and `#7412`, `#8747`.
export function getValueAxisStart(baseAxis: Axis2D, valueAxis: Axis2D) {
    let startValue = valueAxis.model.get('startValue');
    if (!startValue) {
        startValue = 0;
    }
    return valueAxis.toGlobalCoord(
        valueAxis.dataToCoord(
            valueAxis.type === 'log'
            ? (startValue > 0 ? startValue : 1)
            : startValue));
}
