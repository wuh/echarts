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

import BoundingRect, { RectLike } from 'zrender/src/core/BoundingRect';
import type { CoordinateSystemDataLayout, NullUndefined, OrdinalNumber, ZRRectLike } from '../../util/types';
import {
    CoordinateSystem, CoordinateSystemMaster
} from '../CoordinateSystem';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import SeriesModel from '../../model/Series';
import MatrixModel, {
    MatrixCoordRangeOption,
    MatrixDimensionCellOption, MatrixDimensionLevelOption, MatrixDimensionModel
} from './MatrixModel';
import { LayoutRect, getLayoutRect } from '../../util/layout';
import { ListIterator, ParsedModelFinder, ParsedModelFinderKnown } from '../../util/model';
import { eqNaN, isArray, retrieve2 } from 'zrender/src/core/util';
import Point from 'zrender/src/core/Point';
import { WH, XY, expandOrShrinkRect } from '../../util/graphic';
import Model from '../../model/Model';
import type {
    MatrixCellLayoutInfo,
    MatrixDimensionCell, MatrixDimPair, MatrixXYLocator
} from './MatrixDim';
import { mathMax, mathMin, parsePositionSizeOption } from '../../util/number';
import {
    createNaNRectLike,
    MatrixClampOption,
    MatrixCellLayoutInfoType,
    parseCoordRangeOption,
    resetXYLocatorRange,
    xyLocatorRangeToRectOneDim
} from './matrixCoordHelper';
import type { MatrixBodyCorner, MatrixBodyOrCornerKind } from './MatrixBodyCorner';
import { error } from '../../util/log';
import { injectCoordSysByOption, simpleCoordSysInjectionProvider } from '../../core/CoordinateSystem';
import {
    LegendAvoidableCoordinateSystem,
    LayoutLegendContext,
    fillLegendGroupSpaceToMargin,
    collectCoordLabelSeries,
    calculateOuterBoundingRectWithLabels,
    calculateSeriesLabelBoundingRects,
    calculateSeriesLabelOverflowMargin,
    isMarginAllZero,
    calculateSymbolRect,
} from '../../util/autoLayout';


class Matrix implements CoordinateSystem, CoordinateSystemMaster, LegendAvoidableCoordinateSystem {

    static readonly dimensions = ['x', 'y', 'value'];
    /**
     * @see fetchers in `model/referHelper.ts`,
     * which is used to parse data in ordinal way.
     * In most series only 'x' and 'y' is required,
     * but some series, such as heatmap, can specify value.
     */
    static getDimensionsInfo() {
        return [
            {name: 'x', type: 'ordinal' as const},
            {name: 'y', type: 'ordinal' as const},
            {name: 'value'},
        ];
    }

    readonly dimensions = Matrix.dimensions;
    readonly type = 'matrix';

    private _model: MatrixModel;
    private _dimModels: {
        x: MatrixDimensionModel;
        y: MatrixDimensionModel;
    };
    private _dims: MatrixDimPair;

    private _rect: LayoutRect;
    private _ecModel: GlobalModel;

    /** @implements LegendAvoidableCoordinateSystem */
    autoLayoutContext: LayoutLegendContext | undefined;

    static create(ecModel: GlobalModel, api: ExtensionAPI) {
        const matrixList: Matrix[] = [];

        ecModel.eachComponent('matrix', function (matrixModel: MatrixModel) {
            const matrix = new Matrix(matrixModel, ecModel, api);
            matrixList.push(matrix);
            matrixModel.coordinateSystem = matrix;
        });

        // Inject coordinate system
        // PENDING: optimize to not to travel all components?
        //  (collect relevant components in ecModel only when model update?)
        ecModel.eachComponent((mainType, componentModel) => {
            injectCoordSysByOption({
                targetModel: componentModel,
                coordSysType: 'matrix',
                coordSysProvider: simpleCoordSysInjectionProvider,
            });
        });

        // 对所有 matrix 坐标系应用自动布局
        matrixList.forEach(matrix => {
            matrix.applyAutoLayout(ecModel, api);
        });
        return matrixList;
    }

    constructor(matrixModel: MatrixModel, ecModel: GlobalModel, api: ExtensionAPI) {
        this._model = matrixModel;
        this._ecModel = ecModel;
        const models = this._dimModels = {
            x: matrixModel.getDimensionModel('x'),
            y: matrixModel.getDimensionModel('y'),
        };
        this._dims = {
            x: models.x.dim,
            y: models.y.dim,
        };

        this._resize(matrixModel, api);
    }

    getRect(): LayoutRect {
        return this._rect;
    }

    private _resize(matrixModel: MatrixModel, api: ExtensionAPI) {
        const rect = this._rect = getLayoutRect(matrixModel.getBoxLayoutParams(), {
            width: api.getWidth(),
            height: api.getHeight(),
        });

        this._relayoutCells(rect);
    }

    /**
     * Re-layout cells based on current rect
     * This is used after rect is adjusted by auto layout
     */
    private _relayoutCells(rect: LayoutRect): void {
        const dims = this._dims;
        const dimModels = this._dimModels;

        layOutUnitsOnDimension(dimModels, dims, rect, 0);
        layOutUnitsOnDimension(dimModels, dims, rect, 1);

        layOutDimCellsRestInfoByUnit(0, dims);
        layOutDimCellsRestInfoByUnit(1, dims);

        layOutBodyCornerCellMerge(this._model.getBody(), dims);
        layOutBodyCornerCellMerge(this._model.getCorner(), dims);
    }

    /**
     * @implement
     * - The input is allowed to be `[NaN/null/undefined, xxx]`/`[xxx, NaN/null/undefined]`;
     *  the return is `[NaN, xxxresult]`/`[xxxresult, NaN]` or clamped boundary value if
     *  `clamp` passed. This is for the usage that only get coord on single x or y.
     * - Alwasy return an numeric array, but never be null/undefined.
     *  If it can not be located or invalid, return `[NaN, NaN]`.
     */
    dataToPoint(
        data: MatrixCoordRangeOption[],
        opt?: Parameters<Matrix['dataToLayout']>[1],
        out?: number[]
    ): number[] {
        out = out || [];

        this.dataToLayout(data, opt, _dtpOutDataToLayout);

        out[0] = _dtpOutDataToLayout.rect.x + _dtpOutDataToLayout.rect.width / 2;
        out[1] = _dtpOutDataToLayout.rect.y + _dtpOutDataToLayout.rect.height / 2;
        return out;
    }

    /**
     * @implement
     * - The input is allowed to be `[NaN/null/undefined, xxx]`/`[xxx, NaN/null/undefined]`;
     *  the return is `{x: NaN, width: NaN, y: xxxresulty, height: xxxresulth}`/
     *  `{y: NaN, height: NaN, x: xxxresultx, width: xxxresultw}` or clamped boundary value
     *  if `clamp` passed. This is for the usage that only get coord on single x or y.
     * - The returned `out.rect` and `out.matrixXYLocatorRange` is always an object or an 2d-array,
     *  but never be null/undefined. If it cannot be located or invalid, `NaN` is in their
     *  corresponding number props.
     * - Do not provide `out.contentRect`, because it's allowed to input non-leaf dimension x/y or
     *  a range of x/y, which determines a rect covering multiple cells (even not merged), in which
     *  case the padding and borderWidth can not be determined to make a contentRect. Therefore only
     *  return `out.rect` in any case for consistency. The caller is responsible for adding space to
     *  avoid covering cell borders, if necessary.
     */
    dataToLayout(
        data: MatrixCoordRangeOption[],
        opt?: {
            // No clamp by default, considering the possibility of supporting dataZoom (overflow/scroll).
            clamp?: MatrixClampOption | NullUndefined;
            // Expand if cell merging is encountered.
            //  - `false`: If intersecting with a rect of merged cells, expand the result to cover it.
            //      This is the default option, becuase `series.data` do not support the format
            //      `MatrixCoordRangeOption` (e.g., `[[3,5], [5,8]]`), thus merged cells can only
            //      be located by single cell locators (e.g., `[3, 5]`).
            //  - `true`: regardless of cell merging, even if the resulting rect spans accorss the merged cells.
            ignoreMergeCells?: boolean;
        },
        out?: CoordinateSystemDataLayout
    ): CoordinateSystemDataLayout {
        const dims = this._dims;

        out = out || {} as CoordinateSystemDataLayout;
        const outRect = out.rect = out.rect || {} as RectLike;
        outRect.x = outRect.y = outRect.width = outRect.height = NaN;
        const outLocRange = out.matrixXYLocatorRange = resetXYLocatorRange(out.matrixXYLocatorRange);

        if (!isArray(data)) {
            if (__DEV__) {
                error('Input data must be an array in `convertToLayout`, `convertToPixel`');
            }
            return out;
        }

        parseCoordRangeOption(
            outLocRange,
            null,
            data,
            dims,
            retrieve2(opt && opt.clamp, MatrixClampOption.none)
        );

        if (!opt || !opt.ignoreMergeCells) {
            if (!opt || opt.clamp !== MatrixClampOption.corner) {
                this._model.getBody().expandRangeByCellMerge(outLocRange);
            }
            if (!opt || opt.clamp !== MatrixClampOption.body) {
                this._model.getCorner().expandRangeByCellMerge(outLocRange);
            }
        }

        xyLocatorRangeToRectOneDim(outRect, outLocRange, dims, 0);
        xyLocatorRangeToRectOneDim(outRect, outLocRange, dims, 1);

        return out;
    }

    /**
     * The returned locator pair can be the input of `dataToPoint` or `dataToLayout`.
     *
     * If point[0] is out of the matrix rect,
     *  the out[0] is NaN;
     * else if it is on the right of top-left corner of body,
     *  the out[0] is the oridinal number (>= 0).
     * else
     *  out[0] is the locator for corner or header (<= 0).
     *
     * The same rule goes for point[1] and out[1].
     *
     * But point[0] and point[1] are calculated separately, i.e.,
     * the reuslt can be `[1, NaN]` or `[NaN, 1]` if only one dimension is out of boundary.
     *
     * @implement
     */
    pointToData(
        point: number[],
        opt?: {
            clamp?: MatrixClampOption | NullUndefined
        },
        out?: MatrixXYLocator[]
    ): MatrixXYLocator[] {
        const dims = this._dims;
        pointToDataOneDimPrepareCtx(_tmpCtxPointToData, 0, dims, point, opt && opt.clamp);
        pointToDataOneDimPrepareCtx(_tmpCtxPointToData, 1, dims, point, opt && opt.clamp);

        out = out || [];
        out[0] = out[1] = NaN;

        if (_tmpCtxPointToData.y === CtxPointToDataAreaType.inCorner
            && _tmpCtxPointToData.x === CtxPointToDataAreaType.inBody
        ) {
            pointToDataOnlyHeaderFillOut(_tmpCtxPointToData, out, 0, dims);
        }
        else if (_tmpCtxPointToData.x === CtxPointToDataAreaType.inCorner
            && _tmpCtxPointToData.y === CtxPointToDataAreaType.inBody
        ) {
            pointToDataOnlyHeaderFillOut(_tmpCtxPointToData, out, 1, dims);
        }
        else {
            pointToDataBodyCornerFillOut(_tmpCtxPointToData, out, 0, dims);
            pointToDataBodyCornerFillOut(_tmpCtxPointToData, out, 1, dims);
        }

        return out;
    }

    convertToPixel(
        ecModel: GlobalModel,
        finder: ParsedModelFinder,
        value: Parameters<Matrix['dataToPoint']>[0],
        opt?: Parameters<Matrix['dataToPoint']>[1],
    ): ReturnType<Matrix['dataToPoint']> | NullUndefined {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? coordSys.dataToPoint(value, opt) : undefined;
    }

    convertToLayout(
        ecModel: GlobalModel,
        finder: ParsedModelFinder,
        value: Parameters<Matrix['dataToLayout']>[0],
        opt?: Parameters<Matrix['dataToLayout']>[1],
    ): ReturnType<Matrix['dataToLayout']> | NullUndefined {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? coordSys.dataToLayout(value, opt) : undefined;
    }

    convertFromPixel(
        ecModel: GlobalModel,
        finder: ParsedModelFinder,
        pixel: Parameters<Matrix['pointToData']>[0],
        opt?: Parameters<Matrix['pointToData']>[1],
    ): ReturnType<Matrix['pointToData']> | NullUndefined {
        const coordSys = getCoordSys(finder);
        return coordSys === this ? coordSys.pointToData(pixel, opt) : undefined;
    }

    containPoint(
        point: number[]
    ): boolean {
        return this._rect.contain(point[0], point[1]);
    }

    /** @implements LegendAvoidableCoordinateSystem */
    getOuterBoundingRect(): BoundingRect | null {
        return this.getRect();
    }

    /** @implements LegendAvoidableCoordinateSystem */
    applyAutoLayout(ecModel: GlobalModel, api: ExtensionAPI): void {
        let finalBoundingRect: ZRRectLike;

        // 步骤1：处理图例自动布局避让
        // 注意：图例避让必须在标签溢出处理之前，因为图例位置会影响后续的标签边界计算
        if (this.autoLayoutContext != null) {
            if (this.autoLayoutContext.needLayout === true) {
                // 计算包含矩阵标签和系列标签的合并边界矩形，用于图例位置计算
                finalBoundingRect = this._calculateLabelBoundingRect(api, this.getRect());
                // 根据图例分组计算所需空间，并累积到 autoLayoutContext.margin
                fillLegendGroupSpaceToMargin(
                    this.autoLayoutContext.group,
                    api,
                    finalBoundingRect,
                    null,
                    this.autoLayoutContext
                );
            }

            // 应用图例避让所需的 margin，压缩矩阵区域为图例腾出空间
            if (this.autoLayoutContext.margin != null) {
                const contextMargin = this.autoLayoutContext.margin;
                const rect = this.getRect();

                if (rect) {
                    expandOrShrinkRect(rect, contextMargin, true, true);
                    finalBoundingRect && expandOrShrinkRect(finalBoundingRect, contextMargin, true, true);
                    // 矩阵区域压缩后，需要重新计算所有单元格的位置
                    this._relayoutCells(rect);
                }
            }
        }

        // 步骤2：处理系列标签溢出画布的自适应调整
        // 在完成图例避让后，检查系列标签是否超出画布边界，必要时扩展矩阵区域
        if (this._model.get('adaptiveLayout')) {
            const labelRefContainer = {
                x: 0,
                y: 0,
                width: api.getWidth(),
                height: api.getHeight()
            } as ZRRectLike;

            const seriesLabelOverflowMargin = this._calculateSeriesLabelOverflowMargin(labelRefContainer, api);
            if (seriesLabelOverflowMargin) {
                const rect = this.getRect();
                // 扩展矩阵区域以容纳溢出的标签
                expandOrShrinkRect(rect, seriesLabelOverflowMargin, true, true);
                finalBoundingRect && expandOrShrinkRect(finalBoundingRect, seriesLabelOverflowMargin, true, true);
                this._relayoutCells(rect);
                // 区域扩展后，需要重新计算最终边界矩形（因为标签位置可能已改变）
                if (finalBoundingRect) {
                    finalBoundingRect = this._calculateLabelBoundingRect(api, rect);
                }
            }
        }

        // 步骤3：将最终边界矩形写入上下文，供图例对齐和后续布局使用
        if (this.autoLayoutContext?.needLayout === true) {
            this.autoLayoutContext.finalBoundingRect = finalBoundingRect;
        }
    }

    /**
     * 计算矩阵坐标系中所有系列标签的边界矩形。
     *
     * 用于标签溢出检测和图例避让计算。
     */
    private _calculateSeriesLabelBoundingRects(seriesList: SeriesModel[], api: ExtensionAPI): Array<{
        rect: BoundingRect;
        textAlign: string;
    }> {
        const matrixCoord = this;
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
                    const dataValue = data.getValues(['x', 'y'], idx);
                    const point = matrixCoord.dataToPoint(dataValue);
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

    /**
     * 计算系列标签溢出参考容器所需的边距。
     * 用于自适应布局：当标签超出画布时，返回需要扩展的边距数组 [top, right, bottom, left]。
     * 如果标签未溢出或无需扩展，返回 null。
     */
    private _calculateSeriesLabelOverflowMargin(
        refContainer: RectLike,
        api: ExtensionAPI
    ): number[] | null {
        const seriesList = collectCoordLabelSeries(this._ecModel, this);
        if (seriesList.length === 0) {
            return null;
        }

        const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);
        const seriesLabelOverflowMargin = calculateSeriesLabelOverflowMargin(
            seriesLabelBoundingRects,
            refContainer
        );

        return isMarginAllZero(seriesLabelOverflowMargin) ? null : seriesLabelOverflowMargin;
    }

    /**
     * 计算包含矩阵标签和系列标签的合并边界矩形。
     * 用于图例自动布局避让：图例需要知道矩阵区域加上所有标签后的实际占用空间。
     *
     * @param api ExtensionAPI 实例
     * @param refContainer 参考容器矩形（当前未使用，保留用于未来扩展）
     * @returns 合并后的边界矩形，包含矩阵标签和系列标签
     */
    private _calculateLabelBoundingRect(
        api: ExtensionAPI,
        refContainer: RectLike
    ): RectLike {
        const matrixRectWithLabels = this._rect;
        if (!matrixRectWithLabels) {
            return this.getRect();
        }

        const seriesList = collectCoordLabelSeries(this._ecModel, this);
        const seriesLabelBoundingRects = this._calculateSeriesLabelBoundingRects(seriesList, api);
        if (seriesLabelBoundingRects.length > 0) {
            // 合并矩阵标签区域和系列标签区域，得到完整的占用空间
            return calculateOuterBoundingRectWithLabels(
                matrixRectWithLabels,
                seriesLabelBoundingRects
            );
        }

        return matrixRectWithLabels;
    }
}

const _dtpOutDataToLayout = {rect: createNaNRectLike()};
const _ptdLevelIt = new ListIterator<MatrixCellLayoutInfo>();
const _ptdDimCellIt = new ListIterator<MatrixDimensionCell>();


function layOutUnitsOnDimension(
    dimModels: Matrix['_dimModels'],
    dims: MatrixDimPair,
    matrixRect: RectLike,
    dimIdx: number
): void {
    const otherDimIdx = 1 - dimIdx;
    const thisDim = dims[XY[dimIdx]];
    const otherDim = dims[XY[otherDimIdx]];
    // Notice: If matrix.x/y.show is false, still lay out, to ensure the
    // consistent return of `dataToLayout`.
    const otherDimShow = otherDim.shouldShow();

    // Reset
    for (const it = thisDim.resetCellIterator(); it.next();) {
        it.item.wh = it.item.xy = NaN;
    }
    for (const it = otherDim.resetLayoutIterator(null, dimIdx); it.next();) {
        it.item.wh = it.item.xy = NaN;
    }

    // Set specified size from option.
    let restSize = matrixRect[WH[dimIdx]];
    let restCellsCount = thisDim.getLocatorCount(dimIdx) + otherDim.getLocatorCount(dimIdx);
    const tmpLevelModel = new Model<MatrixDimensionLevelOption>();
    for (const it = otherDim.resetLevelIterator(); it.next();) {
        // Consider `matrix.x.levelSize` and `matrix.x.levels[i].levelSize`.
        tmpLevelModel.option = it.item.option;
        tmpLevelModel.parentModel = dimModels[XY[otherDimIdx]];
        layOutSpecified(it.item, otherDimShow ? tmpLevelModel.get('levelSize') : 0);
    }
    const tmpCellModel = new Model<MatrixDimensionCellOption>();
    for (const it = thisDim.resetCellIterator(); it.next();) {
        // Only leaf support size specification, to avoid unnecessary complexity.
        if (it.item.type === MatrixCellLayoutInfoType.leaf) {
            tmpCellModel.option = it.item.option;
            tmpCellModel.parentModel = undefined;
            layOutSpecified(it.item, tmpCellModel.get('size'));
        }
    }
    function layOutSpecified(item: MatrixCellLayoutInfo, sizeOption: unknown): void {
        const size = parseSizeOption(sizeOption, dimIdx, matrixRect);
        if (!eqNaN(size)) {
            item.wh = confineSize(size, restSize);
            restSize = confineSize(restSize - item.wh);
            restCellsCount--;
        }
    }

    // Set all sizes and positions to levels and leaf cells of which size is unspecified.
    // Contents lay out based on matrix, rather than inverse; therefore do not support
    // calculating size based on content, but allocate equally.
    const computedCellWH = restCellsCount ? (restSize / restCellsCount) : 0;
    // If all size specified, but some space remain (may also caused by matrix.x/y.show: false)
    // do not align to the big most edge.
    const notAlignToBigmost = !restCellsCount && restSize >= 1; // `1` for cumulative precision error.
    let currXY = matrixRect[XY[dimIdx]];
    const maxLocator = thisDim.getLocatorCount(dimIdx) - 1;
    const it = new ListIterator<MatrixCellLayoutInfo>();

    // Lay out levels of the perpendicular dim.
    for (otherDim.resetLayoutIterator(it, dimIdx); it.next();) {
        layOutUnspecified(it.item);
    }
    for (thisDim.resetLayoutIterator(it, dimIdx); it.next();) {
        layOutUnspecified(it.item);
    }
    function layOutUnspecified(item: MatrixCellLayoutInfo) {
        if (eqNaN(item.wh)) {
            item.wh = computedCellWH;
        }
        item.xy = currXY;
        if (item.id[XY[dimIdx]] === maxLocator && !notAlignToBigmost) {
            // Align to the rightmost border, consider cumulative precision error.
            item.wh = matrixRect[XY[dimIdx]] + matrixRect[WH[dimIdx]] - item.xy;
        }
        currXY += item.wh;
    }
}

function layOutDimCellsRestInfoByUnit(dimIdx: number, dims: MatrixDimPair): void {
    // Finally save layout info based on the unit leaves and levels.
    for (const it = dims[XY[dimIdx]].resetCellIterator(); it.next();) {
        const dimCell = it.item;
        layOutRectOneDimBasedOnUnit(dimCell.rect, dimIdx, dimCell.id, dimCell.span, dims);
        // Consider level varitation on tree leaves, should extend the size to touch matrix body
        // to avoid weird appearance.
        layOutRectOneDimBasedOnUnit(dimCell.rect, 1 - dimIdx, dimCell.id, dimCell.span, dims);

        if (dimCell.type === MatrixCellLayoutInfoType.nonLeaf) {
            // `xy` and `wh` need to be saved in non-leaf since it supports locating by non-leaf
            // in `dataToPoint` or `dataToLayout`.
            dimCell.xy = dimCell.rect[XY[dimIdx]];
            dimCell.wh = dimCell.rect[WH[dimIdx]];
        }
    }
}

function layOutBodyCornerCellMerge(bodyOrCorner: MatrixBodyCorner<MatrixBodyOrCornerKind>, dims: MatrixDimPair) {
    bodyOrCorner.travelExistingCells(cell => {
        const computedSpan = cell.span;
        if (computedSpan) {
            const layoutRect = cell.spanRect;
            const id = cell.id;
            layOutRectOneDimBasedOnUnit(layoutRect, 0, id, computedSpan, dims);
            layOutRectOneDimBasedOnUnit(layoutRect, 1, id, computedSpan, dims);
        }
    });
}

// Save to rect for rendering.
function layOutRectOneDimBasedOnUnit(
    outRect: RectLike, dimIdx: number, id: Point, span: Point, dims: MatrixDimPair
): void {
    outRect[WH[dimIdx]] = 0;
    const locator = id[XY[dimIdx]];
    const dim = locator < 0 ? dims[XY[1 - dimIdx]] : dims[XY[dimIdx]];
    const layoutUnit = dim.getUnitLayoutInfo(dimIdx, id[XY[dimIdx]]);
    outRect[XY[dimIdx]] = layoutUnit.xy;
    outRect[WH[dimIdx]] = layoutUnit.wh;

    if (span[XY[dimIdx]] > 1) {
        const layoutUnit2 = dim.getUnitLayoutInfo(dimIdx, id[XY[dimIdx]] + span[XY[dimIdx]] - 1);
        // Be careful the cumulative error - cell must be aligned.
        outRect[WH[dimIdx]] = layoutUnit2.xy + layoutUnit2.wh - layoutUnit.xy;
    }
}

/**
 * Return NaN if not defined or invalid.
 */
function parseSizeOption(
    sizeOption: unknown,
    dimIdx: number,
    matrixRect: RectLike,
): number {
    const sizeNum = parsePositionSizeOption(sizeOption, matrixRect[WH[dimIdx]]);
    return confineSize(sizeNum, matrixRect[WH[dimIdx]]);
}

function confineSize(
    sizeNum: number,
    sizeLimit?: number,
): number {
    return Math.max(Math.min(sizeNum, retrieve2(sizeLimit, Infinity)), 0);
}

function getCoordSys(finder: ParsedModelFinderKnown): Matrix {
    const matrixModel = finder.matrixModel as MatrixModel;
    const seriesModel = finder.seriesModel;

    const coordSys = matrixModel
        ? matrixModel.coordinateSystem
        : seriesModel
        ? seriesModel.coordinateSystem
        : null;

    return coordSys as Matrix;
}

const CtxPointToDataAreaType = {inBody: 1, inCorner: 2, outside: 3};
type CtxPointToDataAreaType = (typeof CtxPointToDataAreaType)[keyof typeof CtxPointToDataAreaType];
type CtxPointToData = {
    x: CtxPointToDataAreaType | NullUndefined;
    y: CtxPointToDataAreaType | NullUndefined;
    point: number[]; // If clamp required, this point is clamped after prepared.
};
// For handy performance optimization in pointToData.
const _tmpCtxPointToData: CtxPointToData = {x: null, y: null, point: []};

function pointToDataOneDimPrepareCtx(
    ctx: CtxPointToData,
    dimIdx: number,
    dims: MatrixDimPair,
    point: number[],
    clamp: MatrixClampOption | NullUndefined
) {
    const thisDim = dims[XY[dimIdx]];
    const otherDim = dims[XY[1 - dimIdx]];

    // Notice: considered cases: `matrix.x/y.show: false`, `matrix.x/y.data` is empty.
    // In this cases the `layout.xy` is on the edge and `layout.wh` is `0`; they still can be
    // use to calculate clampping.

    const bodyMaxUnit = thisDim.getUnitLayoutInfo(dimIdx, thisDim.getLocatorCount(dimIdx) - 1);
    const body0Unit = thisDim.getUnitLayoutInfo(dimIdx, 0);
    const cornerMinUnit = otherDim.getUnitLayoutInfo(dimIdx, -otherDim.getLocatorCount(dimIdx));
    const cornerMinus1Unit = otherDim.shouldShow() ? otherDim.getUnitLayoutInfo(dimIdx, -1) : null;

    let coord = ctx.point[dimIdx] = point[dimIdx]; // Transfer the oridinal coord.

    if (!body0Unit && !cornerMinus1Unit) {
        ctx[XY[dimIdx]] = CtxPointToDataAreaType.outside;
        return;
    }

    if (clamp === MatrixClampOption.body) {
        if (body0Unit) {
            ctx[XY[dimIdx]] = CtxPointToDataAreaType.inBody;
            coord = mathMin(bodyMaxUnit.xy + bodyMaxUnit.wh, mathMax(body0Unit.xy, coord));
            ctx.point[dimIdx] = coord;
        }
        else {
            // If clamp to body, the result must not be in header.
            ctx[XY[dimIdx]] = CtxPointToDataAreaType.outside;
        }
        return;
    }
    else if (clamp === MatrixClampOption.corner) {
        if (cornerMinus1Unit) {
            ctx[XY[dimIdx]] = CtxPointToDataAreaType.inCorner;
            coord = mathMin(cornerMinus1Unit.xy + cornerMinus1Unit.wh, mathMax(cornerMinUnit.xy, coord));
            ctx.point[dimIdx] = coord;
        }
        else {
            // If clamp to corner, the result must not be in body.
            ctx[XY[dimIdx]] = CtxPointToDataAreaType.outside;
        }
        return;
    }

    const pxLoc0 = body0Unit ? body0Unit.xy : cornerMinus1Unit ? cornerMinus1Unit.xy + cornerMinus1Unit.wh : NaN;
    const pxMin = cornerMinUnit ? cornerMinUnit.xy : pxLoc0;
    const pxMax = bodyMaxUnit ? bodyMaxUnit.xy + bodyMaxUnit.wh : pxLoc0;

    if (coord < pxMin) {
        if (!clamp) {
            // Quick pass for later calc, since mouse event on any place will enter this method if use `pointToData`.
            ctx[XY[dimIdx]] = CtxPointToDataAreaType.outside;
            return;
        }
        coord = pxMin;
    }
    else if (coord > pxMax) {
        if (!clamp) {
            ctx[XY[dimIdx]] = CtxPointToDataAreaType.outside;
            return;
        }
        coord = pxMax;
    }
    ctx.point[dimIdx] = coord; // Save the updated coord.

    ctx[XY[dimIdx]] = pxLoc0 <= coord && coord <= pxMax ? CtxPointToDataAreaType.inBody
        : pxMin <= coord && coord <= pxLoc0 ? CtxPointToDataAreaType.inCorner
        : CtxPointToDataAreaType.outside;

    // Every props in ctx must be set in every branch of this method.
}

// Assume partialOut has been set to NaN outside.
// This method may fill out[0] and out[1] in one call.
function pointToDataOnlyHeaderFillOut(
    ctx: CtxPointToData,
    partialOut: (OrdinalNumber | MatrixXYLocator)[],
    dimIdx: number,
    dims: MatrixDimPair,
): void {
    const otherDimIdx = 1 - dimIdx;

    if (ctx[XY[dimIdx]] === CtxPointToDataAreaType.outside) {
        return;
    }
    for (dims[XY[dimIdx]].resetCellIterator(_ptdDimCellIt); _ptdDimCellIt.next();) {
        const cell = _ptdDimCellIt.item;
        if (isCoordInRect(ctx.point[dimIdx], cell.rect, dimIdx)
            && isCoordInRect(ctx.point[otherDimIdx], cell.rect, otherDimIdx)
        ) {
            // non-leaves are also allowed to be located.
            // If the point is in x or y dimension cell area, should check both x and y coord to
            // determine a cell; in this way a non-leaf cell can be determined.
            partialOut[dimIdx] = cell.ordinal;
            partialOut[otherDimIdx] = cell.id[XY[otherDimIdx]];
            return;
        }
    }
}

// Assume partialOut has been set to NaN outside.
// This method may fill out[0] and out[1] in one call.
function pointToDataBodyCornerFillOut(
    ctx: CtxPointToData,
    partialOut: (OrdinalNumber | MatrixXYLocator)[],
    dimIdx: number,
    dims: MatrixDimPair,
): void {
    if (ctx[XY[dimIdx]] === CtxPointToDataAreaType.outside) {
        return;
    }
    const dim = ctx[XY[dimIdx]] === CtxPointToDataAreaType.inCorner
        ? dims[XY[1 - dimIdx]] : dims[XY[dimIdx]];
    for (dim.resetLayoutIterator(_ptdLevelIt, dimIdx); _ptdLevelIt.next();) {
        if (isCoordInLayoutInfo(ctx.point[dimIdx], _ptdLevelIt.item)) {
            partialOut[dimIdx] = _ptdLevelIt.item.id[XY[dimIdx]];
            return;
        }
    }
}

function isCoordInLayoutInfo(coord: number, cell: MatrixCellLayoutInfo): boolean {
    return cell.xy <= coord && coord <= cell.xy + cell.wh;
}
function isCoordInRect(coord: number, rect: RectLike, dimIdx: number): boolean {
    return rect[XY[dimIdx]] <= coord && coord <= rect[XY[dimIdx]] + rect[WH[dimIdx]];
}


export default Matrix;
