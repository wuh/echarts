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


import SymbolDraw from '../../chart/helper/SymbolDraw';
import * as numberUtil from '../../util/number';
import SeriesData from '../../data/SeriesData';
import * as markerHelper from './markerHelper';
import MarkerView from './MarkerView';
import { CoordinateSystem } from '../../coord/CoordinateSystem';
import SeriesModel from '../../model/Series';
import MarkPointModel, {MarkPointDataItemOption} from './MarkPointModel';
import GlobalModel from '../../model/Global';
import MarkerModel from './MarkerModel';
import ExtensionAPI from '../../core/ExtensionAPI';
import { HashMap, isFunction, map, filter, curry, extend, retrieve2 } from 'zrender/src/core/util';
import { getECData } from '../../util/innerStore';
import { getVisualFromData } from '../../visual/helper';
import { ZRColor } from '../../util/types';
import SeriesDimensionDefine from '../../data/SeriesDimensionDefine';
import { BoundingRect } from 'zrender';
import { getLabelStatesModels } from '../../label/labelStyle';
import * as symbolUtil from '../../util/symbol';
import { calculateLabelBoundingRectFromPosition, calculateSymbolRectFromParams } from '../../util/autoLayout';

function updateMarkerLayout(
    mpData: SeriesData<MarkPointModel>,
    seriesModel: SeriesModel,
    api: ExtensionAPI
) {
    const coordSys = seriesModel.coordinateSystem;
    const apiWidth = api.getWidth();
    const apiHeight = api.getHeight();
    const coordRect = coordSys && coordSys.getArea && coordSys.getArea();
    mpData.each(function (idx: number) {
        const itemModel = mpData.getItemModel<MarkPointDataItemOption>(idx);
        const isRelativeToCoordinate = itemModel.get('relativeTo') === 'coordinate';
        const width = isRelativeToCoordinate
            ? (coordRect ? coordRect.width : 0)
            : apiWidth;
        const height = isRelativeToCoordinate
            ? (coordRect ? coordRect.height : 0)
            : apiHeight;
        const left = isRelativeToCoordinate && coordRect
            ? coordRect.x
            : 0;
        const top = isRelativeToCoordinate && coordRect
            ? coordRect.y
            : 0;

        let point;
        const xPx = numberUtil.parsePercent(itemModel.get('x'), width) + left;
        const yPx = numberUtil.parsePercent(itemModel.get('y'), height) + top;
        if (!isNaN(xPx) && !isNaN(yPx)) {
            point = [xPx, yPx];
        }
        // Chart like bar may have there own marker positioning logic
        else if (seriesModel.getMarkerPosition) {
            // Use the getMarkerPosition
            point = seriesModel.getMarkerPosition(
                mpData.getValues(mpData.dimensions, idx)
            );
        }
        else if (coordSys) {
            const x = mpData.get(coordSys.dimensions[0], idx);
            const y = mpData.get(coordSys.dimensions[1], idx);
            point = coordSys.dataToPoint([x, y]);
        }

        // Use x, y if has any
        if (!isNaN(xPx)) {
            point[0] = xPx;
        }
        if (!isNaN(yPx)) {
            point[1] = yPx;
        }

        mpData.setItemLayout(idx, point);
    });
}

class MarkPointView extends MarkerView {

    static type = 'markPoint';
    type = MarkPointView.type;

    markerGroupMap: HashMap<SymbolDraw>;

    /**
     * 计算 markPoint 标签的边界矩形，用于自动布局。
     */
    getLabelBoundingRect(
        seriesModel: SeriesModel,
        mpModel: MarkPointModel,
        api: ExtensionAPI
    ): Array<{ rect: BoundingRect; textAlign: string }> {
        const result: Array<{ rect: BoundingRect; textAlign: string }> = [];

        // 获取全局的标签(label)配置。优先级最低，后续单个数据项可覆盖。
        const globalLabelStatesModels = getLabelStatesModels(mpModel);
        const globalLabelModel = globalLabelStatesModels.normal;

        // 检查系列是否存在坐标系。markPoint 必须依赖坐标系才能计算布局，否则直接返回空结果。
        const coordSys = seriesModel.coordinateSystem;
        if (!coordSys) {
            return result;
        }

        // 生成 markPoint 数据集（mpData），用于后续布局及标签计算
        const mpData = createData(coordSys, seriesModel, mpModel);

        // 暂时将新的数据集 mpData 绑定到 mpModel，以便 getFormattedLabel 能查询到最新数据
        const originalData = mpModel.getData();
        mpModel.setData(mpData);

        // 计算 markPoint 各点的可视化布局（像素坐标），为标签布局做准备
        updateMarkerLayout(mpData, seriesModel, api);

        mpData.each(function (idx: number) {
            // 注释：标签配置优先级处理，先获取全局配置，后检测数据项上是否有自定义
            const itemModel = mpData.getItemModel<MarkPointDataItemOption>(idx);
            let labelModel = globalLabelModel;

            // 如果数据项有自定义配置（通常为单个点的特殊需求），则使用该配置覆盖全局
            if (mpData.hasItemOption) {
                const itemLabelStatesModels = getLabelStatesModels(itemModel);
                const itemLabelModel = itemLabelStatesModels.normal;

                // 如果“显示”、“位置”、“距离”、“字号”任一被重写，则认为数据项有独立标签需求
                if (itemLabelModel.get('show') !== undefined
                    || itemLabelModel.get('position') !== undefined
                    || itemLabelModel.get('distance') !== undefined
                    || itemLabelModel.get('fontSize') !== undefined) {
                    labelModel = itemLabelModel;
                }
            }

            // 标签非显示状态直接跳过，减少无用计算（如默认配置 'show': false 时）
            if (!labelModel.get('show')) {
                return;
            }

            // 只处理“非 inside”标签：在图形外部才可能对自动布局产生影响
            const position = labelModel.get('position') || 'inside';
            if (position === 'inside') {
                return;
            }

            // 布局点坐标检查，避免数据异常导致后续报错
            const point = mpData.getItemLayout(idx);
            if (!point || point.length < 2) {
                return;
            }

            // 优先获取数据项上符号类型和尺寸，没有则回退到全局 markPoint 配置
            let symbol = itemModel.getShallow('symbol');
            let symbolSize = itemModel.getShallow('symbolSize');

            if (symbol == null) {
                symbol = mpModel.get('symbol');
            }
            if (symbolSize == null) {
                symbolSize = mpModel.get('symbolSize');
            }

            // 支持 symbolSize 配置为回调函数的场景，动态决定当前点尺寸
            if (isFunction(symbolSize)) {
                const rawIdx = mpModel.getRawValue(idx);
                const dataParams = mpModel.getDataParams(idx);
                symbolSize = symbolSize(rawIdx, dataParams);
            }

            // 当图形类型为 'none' 时不应布局标签，直接跳过
            if (symbol === 'none') {
                return;
            }

            // 将 symbolSize 统一处理为 [width, height] 形式，便于后续通用计算
            const normalizedSymbolSize = symbolUtil.normalizeSymbolSize(symbolSize as number | number[]);

            // 基于符号、点坐标和尺寸构造当前点的“符号参考包围盒”（供标签偏移定位参考）
            const symbolRect = calculateSymbolRectFromParams(symbol as string, point, normalizedSymbolSize);

            // 获取格式化后标签文字，若为空则不参与布局
            const labelText = mpModel.getFormattedLabel(idx, 'normal');
            if (labelText == null || labelText === '') {
                return;
            }

            // 结合标签位置、参考矩形以及 labelModel，准确计算本标签包围盒和对齐方式
            const labelRect = calculateLabelBoundingRectFromPosition(
                String(position),        // 标签放置的位置类型（如 'top', 'left'）
                symbolRect,             // 符号参考矩形，为标签定位提供参考点
                labelModel,             // 标签配置模型（决定字体、距离等参数）
                labelText               // 文本内容
            );

            // 结果入队，仅返回有效的 labelRect
            if (labelRect) {
                result.push(labelRect);
            }
        });

        // 恢复 mpModel 的数据引用，保证外部逻辑不受影响
        mpModel.setData(originalData);

        // 返回所有能够被用于自动避让的 label 边界及对齐类型
        return result;
    }

    updateTransform(markPointModel: MarkPointModel, ecModel: GlobalModel, api: ExtensionAPI) {
        ecModel.eachSeries(function (seriesModel) {
            const mpModel = MarkerModel.getMarkerModelFromSeries(seriesModel, 'markPoint') as MarkPointModel;
            if (mpModel) {
                updateMarkerLayout(
                    mpModel.getData(),
                    seriesModel, api
                );
                this.markerGroupMap.get(seriesModel.id).updateLayout();
            }
        }, this);
    }

    renderSeries(
        seriesModel: SeriesModel,
        mpModel: MarkPointModel,
        ecModel: GlobalModel,
        api: ExtensionAPI
    ) {
        const coordSys = seriesModel.coordinateSystem;
        const seriesId = seriesModel.id;
        const seriesData = seriesModel.getData();

        const symbolDrawMap = this.markerGroupMap;
        const symbolDraw = symbolDrawMap.get(seriesId)
            || symbolDrawMap.set(seriesId, new SymbolDraw());

        const mpData = createData(coordSys, seriesModel, mpModel);

        // FIXME
        mpModel.setData(mpData);

        updateMarkerLayout(mpModel.getData(), seriesModel, api);

        mpData.each(function (idx) {
            const itemModel = mpData.getItemModel<MarkPointDataItemOption>(idx);
            let symbol = itemModel.getShallow('symbol');
            let symbolSize = itemModel.getShallow('symbolSize');
            let symbolRotate = itemModel.getShallow('symbolRotate');
            let symbolOffset = itemModel.getShallow('symbolOffset');
            const symbolKeepAspect = itemModel.getShallow('symbolKeepAspect');

            // TODO: refactor needed: single data item should not support callback function
            if (isFunction(symbol) || isFunction(symbolSize) || isFunction(symbolRotate) || isFunction(symbolOffset)) {
                const rawIdx = mpModel.getRawValue(idx);
                const dataParams = mpModel.getDataParams(idx);
                if (isFunction(symbol)) {
                    symbol = symbol(rawIdx, dataParams);
                }
                if (isFunction(symbolSize)) {
                    // FIXME 这里不兼容 ECharts 2.x，2.x 貌似参数是整个数据？
                    symbolSize = symbolSize(rawIdx, dataParams);
                }
                if (isFunction(symbolRotate)) {
                    symbolRotate = symbolRotate(rawIdx, dataParams);
                }
                if (isFunction(symbolOffset)) {
                    symbolOffset = symbolOffset(rawIdx, dataParams);
                }
            }

            const style = itemModel.getModel('itemStyle').getItemStyle();
            const z2 = itemModel.get('z2');
            const color = getVisualFromData(seriesData, 'color') as ZRColor;
            if (!style.fill) {
                style.fill = color;
            }

            mpData.setItemVisual(idx, {
                z2: retrieve2(z2, 0),
                symbol: symbol,
                symbolSize: symbolSize,
                symbolRotate: symbolRotate,
                symbolOffset: symbolOffset,
                symbolKeepAspect: symbolKeepAspect,
                style
            });
        });

        // TODO Text are wrong
        symbolDraw.updateData(mpData);
        this.group.add(symbolDraw.group);

        // Set host model for tooltip
        // FIXME
        mpData.eachItemGraphicEl(function (el) {
            el.traverse(function (child) {
                getECData(child).dataModel = mpModel;
            });
        });

        this.markKeep(symbolDraw);

        symbolDraw.group.silent = mpModel.get('silent') || seriesModel.get('silent');
    }
}

function createData(
    coordSys: CoordinateSystem,
    seriesModel: SeriesModel,
    mpModel: MarkPointModel
) {
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

    const mpData = new SeriesData(coordDimsInfos, mpModel);
    let dataOpt = map(mpModel.get('data'), curry(
            markerHelper.dataTransform, seriesModel
        ));
    if (coordSys) {
        dataOpt = filter(
            dataOpt, curry(markerHelper.dataFilter, coordSys)
        );
    }

    const dimValueGetter = markerHelper.createMarkerDimValueGetter(!!coordSys, coordDimsInfos);
    mpData.initData(dataOpt, null, dimValueGetter);

    return mpData;
}

export default MarkPointView;
