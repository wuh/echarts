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

import SeriesData from '../../data/SeriesData';
import * as numberUtil from '../../util/number';
import * as markerHelper from './markerHelper';
import LineDraw from '../../chart/helper/LineDraw';
import MarkerView from './MarkerView';
import {getStackedDimension} from '../../data/helper/dataStackHelper';
import { CoordinateSystem, isCoordinateSystemType } from '../../coord/CoordinateSystem';
import MarkLineModel, { MarkLine2DDataItemOption, MarkLineOption } from './MarkLineModel';
import { ScaleDataValue, ColorString } from '../../util/types';
import SeriesModel from '../../model/Series';
import { getECData } from '../../util/innerStore';
import ExtensionAPI from '../../core/ExtensionAPI';
import Cartesian2D from '../../coord/cartesian/Cartesian2D';
import GlobalModel from '../../model/Global';
import MarkerModel from './MarkerModel';
import { BoundingRect } from 'zrender';
import { getLabelStatesModels } from '../../label/labelStyle';
import { calculateLabelBoundingRectFromPosition } from '../../util/autoLayout';
import {
    isArray,
    retrieve,
    retrieve2,
    clone,
    extend,
    logError,
    merge,
    map,
    curry,
    filter,
    HashMap,
    isNumber
} from 'zrender/src/core/util';
import { makeInner } from '../../util/model';
import { LineDataVisual } from '../../visual/commonVisualTypes';
import { getVisualFromData } from '../../visual/helper';
import Axis2D from '../../coord/cartesian/Axis2D';
import SeriesDimensionDefine from '../../data/SeriesDimensionDefine';

// Item option for configuring line and each end of symbol.
// Line option. be merged from configuration of two ends.
type MarkLineMergedItemOption = MarkLine2DDataItemOption[number];

const inner = makeInner<{
    // from data
    from: SeriesData<MarkLineModel>
    // to data
    to: SeriesData<MarkLineModel>
}, MarkLineModel>();

const markLineTransform = function (
    seriesModel: SeriesModel,
    coordSys: CoordinateSystem,
    mlModel: MarkLineModel,
    item: MarkLineOption['data'][number]
) {
    const data = seriesModel.getData();

    let itemArray: MarkLineMergedItemOption[];
    if (!isArray(item)) {
        // Special type markLine like 'min', 'max', 'average', 'median'
        const mlType = item.type;
        if (
            mlType === 'min' || mlType === 'max' || mlType === 'average' || mlType === 'median'
            // In case
            // data: [{
            //   yAxis: 10
            // }]
            || (item.xAxis != null || item.yAxis != null)
        ) {

            let valueAxis;
            let value;

            if (item.yAxis != null || item.xAxis != null) {
                valueAxis = coordSys.getAxis(item.yAxis != null ? 'y' : 'x');
                value = retrieve(item.yAxis, item.xAxis);
            }
            else {
                const axisInfo = markerHelper.getAxisInfo(item, data, coordSys, seriesModel);
                valueAxis = axisInfo.valueAxis;
                const valueDataDim = getStackedDimension(data, axisInfo.valueDataDim);
                value = markerHelper.numCalculate(data, valueDataDim, mlType);
            }
            const valueIndex = valueAxis.dim === 'x' ? 0 : 1;
            const baseIndex = 1 - valueIndex;

            // Normized to 2d data with start and end point
            const mlFrom = clone(item) as MarkLine2DDataItemOption[number];
            const mlTo = {
                coord: []
            } as MarkLine2DDataItemOption[number];

            mlFrom.type = null;

            mlFrom.coord = [];
            mlFrom.coord[baseIndex] = -Infinity;
            mlTo.coord[baseIndex] = Infinity;

            const precision = mlModel.get('precision');
            if (precision >= 0 && isNumber(value)) {
                value = +value.toFixed(Math.min(precision, 20));
            }

            mlFrom.coord[valueIndex] = mlTo.coord[valueIndex] = value;

            itemArray = [mlFrom, mlTo, { // Extra option for tooltip and label
                type: mlType,
                valueIndex: item.valueIndex,
                // Force to use the value of calculated value.
                value: value
            }];
        }
        else {
            // Invalid data
            if (__DEV__) {
                logError('Invalid markLine data.');
            }
            itemArray = [];
        }
    }
    else {
        itemArray = item;
    }

    const normalizedItem = [
        markerHelper.dataTransform(seriesModel, itemArray[0]),
        markerHelper.dataTransform(seriesModel, itemArray[1]),
        extend({}, itemArray[2])
    ];

    // Avoid line data type is extended by from(to) data type
    normalizedItem[2].type = normalizedItem[2].type || null;

    // Merge from option and to option into line option
    merge(normalizedItem[2], normalizedItem[0]);
    merge(normalizedItem[2], normalizedItem[1]);

    return normalizedItem;
};

function isInfinity(val: ScaleDataValue) {
    return !isNaN(val as number) && !isFinite(val as number);
}

// If a markLine has one dim
function ifMarkLineHasOnlyDim(
    dimIndex: number,
    fromCoord: ScaleDataValue[],
    toCoord: ScaleDataValue[],
    coordSys: CoordinateSystem
) {
    const otherDimIndex = 1 - dimIndex;
    const dimName = coordSys.dimensions[dimIndex];
    return isInfinity(fromCoord[otherDimIndex]) && isInfinity(toCoord[otherDimIndex])
        && fromCoord[dimIndex] === toCoord[dimIndex] && coordSys.getAxis(dimName).containData(fromCoord[dimIndex]);
}

function markLineFilter(
    coordSys: CoordinateSystem,
    item: MarkLine2DDataItemOption
) {
    if (coordSys.type === 'cartesian2d') {
        const fromCoord = item[0].coord;
        const toCoord = item[1].coord;
        // In case
        // {
        //  markLine: {
        //    data: [{ yAxis: 2 }]
        //  }
        // }
        if (
            fromCoord && toCoord
            && (ifMarkLineHasOnlyDim(1, fromCoord, toCoord, coordSys)
            || ifMarkLineHasOnlyDim(0, fromCoord, toCoord, coordSys))
        ) {
            return true;
        }
    }
    return markerHelper.dataFilter(coordSys, item[0])
        && markerHelper.dataFilter(coordSys, item[1]);
}

function updateSingleMarkerEndLayout(
    data: SeriesData<MarkLineModel>,
    idx: number,
    isFrom: boolean,
    seriesModel: SeriesModel,
    api: ExtensionAPI
) {
    const coordSys = seriesModel.coordinateSystem;
    const itemModel = data.getItemModel<MarkLine2DDataItemOption[number]>(idx);

    let point;
    const xPx = numberUtil.parsePercent(itemModel.get('x'), api.getWidth());
    const yPx = numberUtil.parsePercent(itemModel.get('y'), api.getHeight());
    if (!isNaN(xPx) && !isNaN(yPx)) {
        point = [xPx, yPx];
    }
    else {
        // Chart like bar may have there own marker positioning logic
        if (seriesModel.getMarkerPosition) {
            // Use the getMarkerPosition
            point = seriesModel.getMarkerPosition(
                data.getValues(data.dimensions, idx)
            );
        }
        else {
            const dims = coordSys.dimensions;
            const x = data.get(dims[0], idx);
            const y = data.get(dims[1], idx);
            point = coordSys.dataToPoint([x, y]);
        }
        // Expand line to the edge of grid if value on one axis is Inifnity
        // In case
        //  markLine: {
        //    data: [{
        //      yAxis: 2
        //      // or
        //      type: 'average'
        //    }]
        //  }
        if (isCoordinateSystemType<Cartesian2D>(coordSys, 'cartesian2d')) {
            // TODO: TYPE ts@4.1 may still infer it as Axis instead of Axis2D. Not sure if it's a bug
            const xAxis = coordSys.getAxis('x') as Axis2D;
            const yAxis = coordSys.getAxis('y') as Axis2D;
            const dims = coordSys.dimensions;
            if (isInfinity(data.get(dims[0], idx))) {
                point[0] = xAxis.toGlobalCoord(xAxis.getExtent()[isFrom ? 0 : 1]);
            }
            else if (isInfinity(data.get(dims[1], idx))) {
                point[1] = yAxis.toGlobalCoord(yAxis.getExtent()[isFrom ? 0 : 1]);
            }
        }

        // Use x, y if has any
        if (!isNaN(xPx)) {
            point[0] = xPx;
        }
        if (!isNaN(yPx)) {
            point[1] = yPx;
        }
    }

    data.setItemLayout(idx, point);
}

class MarkLineView extends MarkerView {

    static type = 'markLine';
    type = MarkLineView.type;

    markerGroupMap: HashMap<LineDraw>;

    /**
     * 获取标签的边界矩形。
     *
     * 这个方法的主要目的是为标记线（markLine）的标签计算出它们在图表中的边界矩
     * 形区域，用于处理标签溢出的情况。
     *
     * @param seriesModel 系列模型，包含系列的坐标系、数据等信息。
     * @param mlModel 标记线模型，包含标记线的配置和数据。
     * @param api 扩展API。
     * @returns 包含所有标签边界矩形和文本对齐信息的数组。
     */
    getLabelBoundingRect(
        seriesModel: SeriesModel,
        mlModel: MarkLineModel,
        api: ExtensionAPI
    ): Array<{ rect: BoundingRect; textAlign: string }> {
        // 初始化结果数组，用于存储所有标签的边界信息
        const result: Array<{ rect: BoundingRect; textAlign: string }> = [];

        // 获取系列的坐标系，如果没有坐标系则直接返回空数组
        const coordSys = seriesModel.coordinateSystem;
        if (!coordSys) {
            return result;
        }

        // 创建标记线的数据列表结构，包含起始点数据、结束点数据和线段数据
        const mlData = createList(coordSys, seriesModel, mlModel);
        const lineData = mlData.line;    // 线段数据，用于获取标签配置
        const fromData = mlData.from;    // 起始点数据
        const toData = mlData.to;        // 结束点数据

        // 临时将线段数据设置到模型中，这样getFormattedLabel方法才能正确工作
        // 保存原始数据以便后续恢复
        const originalData = mlModel.getData();
        mlModel.setData(lineData);

        // 计算起始点和结束点的布局信息，这是标签位置计算的前提
        // isFrom参数为true表示起始点，false表示结束点
        fromData.each(function (idx) {
            updateSingleMarkerEndLayout(fromData, idx, true, seriesModel, api);
        });
        toData.each(function (idx) {
            updateSingleMarkerEndLayout(toData, idx, false, seriesModel, api);
        });

        // 获取标记线模型的全局标签状态模型，类似于LineDraw中的makeSeriesScope逻辑
        const globalLabelStatesModels = getLabelStatesModels(mlModel);
        const globalLabelModel = globalLabelStatesModels.normal;  // 获取普通状态下的标签配置

        // 遍历每一根标记线，计算其标签的边界矩形
        lineData.each(function (idx: number) {
            // 获取当前数据项的模型，优先使用数据项级别的配置，其次使用全局配置
            const itemModel = lineData.getItemModel(idx);
            let labelModel = globalLabelModel;

            // 检查数据项是否有自己的标签配置
            if (lineData.hasItemOption) {
                const itemLabelStatesModels = getLabelStatesModels(itemModel);
                const itemLabelModel = itemLabelStatesModels.normal;
                // 如果数据项级别的标签配置中明确指定了show属性，则使用数据项级别的配置
                if (itemLabelModel.get('show') !== undefined) {
                    labelModel = itemLabelModel;
                }
            }

            // 检查标签是否应该显示，如果配置为不显示则跳过当前标记线
            if (!labelModel.get('show')) {
                return;
            }

            // 获取标签的位置配置，支持 'start'（起始点）、'middle'（中间点）、'end'（结束点）
            const position = labelModel.get('position') as string || 'end';
            let point: number[];  // 标签基准点的坐标
            let labelX: number;   // 标签的X坐标
            let labelY: number;   // 标签的Y坐标

            // 根据位置配置确定标签的基准点坐标
            if (position === 'start') {
                // 标签显示在起始点
                point = fromData.getItemLayout(idx);
                labelX = point[0];
                labelY = point[1];
            }
            else if (position === 'middle') {
                // 标签显示在线段中间点
                const fromPoint = fromData.getItemLayout(idx);
                const toPoint = toData.getItemLayout(idx);
                // 确保起始点和结束点的布局信息都存在且有效
                if (fromPoint && toPoint && fromPoint.length >= 2 && toPoint.length >= 2) {
                    // 计算线段的中点坐标
                    point = [
                        (fromPoint[0] + toPoint[0]) / 2,
                        (fromPoint[1] + toPoint[1]) / 2
                    ];
                    labelX = point[0];
                    labelY = point[1];
                }
                else {
                    // 如果无法计算中点，直接跳过当前标记线
                    return;
                }
            }
            else {
                // 默认情况：标签显示在结束点
                point = toData.getItemLayout(idx);
                labelX = point[0];
                labelY = point[1];
            }

            // 确保坐标点有效，否则跳过当前标记线
            if (!point || point.length < 2) {
                return;
            }

            // 获取格式化后的标签文本内容
            const labelText = mlModel.getFormattedLabel(idx, 'normal');
            // 如果没有文本内容或文本为空，则跳过当前标记线
            if (labelText == null || labelText === '') {
                return;
            }

            // 将点坐标转换为0x0尺寸的矩形，中心位于该点，用于后续的标签位置计算
            // 这个矩形作为参考矩形来计算标签的实际位置
            const pointRect = new BoundingRect(labelX, labelY, 0, 0);


            // 使用统一的标签边界计算函数计算标签的实际边界矩形
            // 这个函数会根据position和distance配置自动计算标签的偏移位置
            const labelRect = calculateLabelBoundingRectFromPosition(
                position,                              // 标签位置类型
                pointRect,                             // 参考矩形
                labelModel,                            // 标签模型（用于获取字体信息和距离）
                labelText                              // 标签文本内容
            );

            // 如果成功计算出标签边界，则添加到结果数组中
            if (labelRect) {
                result.push(labelRect);
            }
        });

        // 恢复模型的原始数据设置
        mlModel.setData(originalData);

        // 返回所有标签的边界矩形信息
        return result;
    }

    updateTransform(markLineModel: MarkLineModel, ecModel: GlobalModel, api: ExtensionAPI) {
        ecModel.eachSeries(function (seriesModel) {
            const mlModel = MarkerModel.getMarkerModelFromSeries(seriesModel, 'markLine') as MarkLineModel;
            if (mlModel) {
                const mlData = mlModel.getData();
                const fromData = inner(mlModel).from;
                const toData = inner(mlModel).to;
                // Update visual and layout of from symbol and to symbol
                fromData.each(function (idx) {
                    updateSingleMarkerEndLayout(fromData, idx, true, seriesModel, api);
                    updateSingleMarkerEndLayout(toData, idx, false, seriesModel, api);
                });
                // Update layout of line
                mlData.each(function (idx) {
                    mlData.setItemLayout(idx, [
                        fromData.getItemLayout(idx),
                        toData.getItemLayout(idx)
                    ]);
                });

                this.markerGroupMap.get(seriesModel.id).updateLayout();

            }
        }, this);
    }

    renderSeries(
        seriesModel: SeriesModel,
        mlModel: MarkLineModel,
        ecModel: GlobalModel,
        api: ExtensionAPI
    ) {
        const coordSys = seriesModel.coordinateSystem;
        const seriesId = seriesModel.id;
        const seriesData = seriesModel.getData();

        const lineDrawMap = this.markerGroupMap;
        const lineDraw = lineDrawMap.get(seriesId)
            || lineDrawMap.set(seriesId, new LineDraw());
        this.group.add(lineDraw.group);

        const mlData = createList(coordSys, seriesModel, mlModel);

        const fromData = mlData.from;
        const toData = mlData.to;
        const lineData = mlData.line as SeriesData<MarkLineModel, LineDataVisual>;

        inner(mlModel).from = fromData;
        inner(mlModel).to = toData;
        // Line data for tooltip and formatter
        mlModel.setData(lineData);

        // TODO
        // Functionally, `symbolSize` & `symbolOffset` can also be 2D array now.
        // But the related logic and type definition are not finished yet.
        // Finish it if required
        let symbolType = mlModel.get('symbol');
        let symbolSize = mlModel.get('symbolSize');
        let symbolRotate = mlModel.get('symbolRotate');
        let symbolOffset = mlModel.get('symbolOffset');
        // TODO: support callback function like markPoint
        if (!isArray(symbolType)) {
            symbolType = [symbolType, symbolType];
        }
        if (!isArray(symbolSize)) {
            symbolSize = [symbolSize, symbolSize];
        }
        if (!isArray(symbolRotate)) {
            symbolRotate = [symbolRotate, symbolRotate];
        }
        if (!isArray(symbolOffset)) {
            symbolOffset = [symbolOffset, symbolOffset];
        }

        // Update visual and layout of from symbol and to symbol
        mlData.from.each(function (idx) {
            updateDataVisualAndLayout(fromData, idx, true);
            updateDataVisualAndLayout(toData, idx, false);
        });

        // Update visual and layout of line
        lineData.each(function (idx) {
            const itemModel = lineData.getItemModel<MarkLineMergedItemOption>(idx);
            const lineStyle = itemModel.getModel('lineStyle').getLineStyle();
            // lineData.setItemVisual(idx, {
            //     color: lineColor || fromData.getItemVisual(idx, 'color')
            // });
            lineData.setItemLayout(idx, [
                fromData.getItemLayout(idx),
                toData.getItemLayout(idx)
            ]);
            const z2 = itemModel.get('z2');

            if (lineStyle.stroke == null) {
                lineStyle.stroke = fromData.getItemVisual(idx, 'style').fill;
            }

            lineData.setItemVisual(idx, {
                z2: retrieve2(z2, 0),
                fromSymbolKeepAspect: fromData.getItemVisual(idx, 'symbolKeepAspect'),
                fromSymbolOffset: fromData.getItemVisual(idx, 'symbolOffset'),
                fromSymbolRotate: fromData.getItemVisual(idx, 'symbolRotate'),
                fromSymbolSize: fromData.getItemVisual(idx, 'symbolSize') as number,
                fromSymbol: fromData.getItemVisual(idx, 'symbol'),
                toSymbolKeepAspect: toData.getItemVisual(idx, 'symbolKeepAspect'),
                toSymbolOffset: toData.getItemVisual(idx, 'symbolOffset'),
                toSymbolRotate: toData.getItemVisual(idx, 'symbolRotate'),
                toSymbolSize: toData.getItemVisual(idx, 'symbolSize') as number,
                toSymbol: toData.getItemVisual(idx, 'symbol'),
                style: lineStyle
            });
        });

        lineDraw.updateData(lineData);

        // Set host model for tooltip
        // FIXME
        mlData.line.eachItemGraphicEl(function (el) {
            getECData(el).dataModel = mlModel;

            el.traverse(function (child) {
                getECData(child).dataModel = mlModel;
            });
        });

        function updateDataVisualAndLayout(
            data: SeriesData<MarkLineModel>,
            idx: number,
            isFrom: boolean
        ) {
            const itemModel = data.getItemModel<MarkLineMergedItemOption>(idx);

            updateSingleMarkerEndLayout(
                data, idx, isFrom, seriesModel, api
            );

            const style = itemModel.getModel('itemStyle').getItemStyle();
            if (style.fill == null) {
                style.fill = getVisualFromData(seriesData, 'color') as ColorString;
            }

            data.setItemVisual(idx, {
                symbolKeepAspect: itemModel.get('symbolKeepAspect'),
                // `0` should be considered as a valid value, so use `retrieve2` instead of `||`
                symbolOffset: retrieve2(
                    itemModel.get('symbolOffset', true),
                    (symbolOffset as (string | number)[])[isFrom ? 0 : 1]
                ),
                symbolRotate: retrieve2(
                    itemModel.get('symbolRotate', true),
                    (symbolRotate as number[])[isFrom ? 0 : 1]
                ),
                // TODO: when 2d array is supported, it should ignore parent
                symbolSize: retrieve2(
                    itemModel.get('symbolSize'),
                    (symbolSize as number[])[isFrom ? 0 : 1]
                ),
                symbol: retrieve2(
                    itemModel.get('symbol', true),
                    (symbolType as string[])[isFrom ? 0 : 1]
                ),
                style
            });
        }

        this.markKeep(lineDraw);

        lineDraw.group.silent = mlModel.get('silent') || seriesModel.get('silent');
    }
}

function createList(coordSys: CoordinateSystem, seriesModel: SeriesModel, mlModel: MarkLineModel) {

    let coordDimsInfos: SeriesDimensionDefine[];
    if (coordSys) {
        coordDimsInfos = map(coordSys && coordSys.dimensions, function (coordDim) {
            const info = seriesModel.getData().getDimensionInfo(
                seriesModel.getData().mapDimension(coordDim)
            ) || {};
            // In map series data don't have lng and lat dimension. Fallback to same with coordSys
            return extend(extend({}, info), {
                name: coordDim,
                // DON'T use ordinalMeta to parse and collect ordinal.
                ordinalMeta: null
            });
        });
    }
    else {
        coordDimsInfos = [{
            name: 'value',
            type: 'float'
        }];
    }

    const fromData = new SeriesData(coordDimsInfos, mlModel);
    const toData = new SeriesData(coordDimsInfos, mlModel);
    // No dimensions
    const lineData = new SeriesData([], mlModel);

    let optData = map(mlModel.get('data'), curry(
        markLineTransform, seriesModel, coordSys, mlModel
    ));
    if (coordSys) {
        optData = filter(
            optData, curry(markLineFilter, coordSys)
        );
    }

    const dimValueGetter = markerHelper.createMarkerDimValueGetter(!!coordSys, coordDimsInfos);

    fromData.initData(
        map(optData, function (item) {
            return item[0];
        }),
        null,
        dimValueGetter
    );
    toData.initData(
        map(optData, function (item) {
            return item[1];
        }),
        null,
        dimValueGetter
    );
    lineData.initData(
        map(optData, function (item) {
            return item[2];
        })
    );
    lineData.hasItemOption = true;

    return {
        from: fromData,
        to: toData,
        line: lineData
    };
}

export default MarkLineView;
