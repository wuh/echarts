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

import * as zrUtil from 'zrender/src/core/util';
import VisualMapView from './VisualMapView';
import * as graphic from '../../util/graphic';
import {createSymbol} from '../../util/symbol';
import * as layout from '../../util/layout';
import * as helper from './helper';
import type PiecewiseModel from './PiecewiseModel';
import { TextAlign } from 'zrender/src/core/types';
import { VisualMappingOption } from '../../visual/VisualMapping';
import { createTextStyle } from '../../label/labelStyle';
import GlobalModel from '../../model/Global';
import ExtensionAPI from '../../core/ExtensionAPI';
import { ZRRectLike } from '../../util/types';
import { applyPaddingToRect } from '../../util/autoLayout';

class PiecewiseVisualMapView extends VisualMapView {

    static type = 'visualMap.piecewise';

    type = PiecewiseVisualMapView.type;

    visualMapModel: PiecewiseModel;

    protected doRender(
        visualMapModel: PiecewiseModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: unknown) {
        const thisGroup = this.group;

        thisGroup.removeAll();

        const textGap = visualMapModel.get('textGap');
        const textStyleModel = visualMapModel.textStyleModel;
        const itemAlign = this._getItemAlign();
        const itemSize = visualMapModel.itemSize;
        const viewData = this._getViewData();
        const endsText = viewData.endsText;
        const showLabel = zrUtil.retrieve(visualMapModel.get('showLabel', true), !endsText);
        const silent = !visualMapModel.get('selectedMode');

        endsText && this._renderEndsText(
            thisGroup, endsText[0], itemSize, showLabel, itemAlign
        );

        zrUtil.each(viewData.viewPieceList, function (item: typeof viewData.viewPieceList[number]) {
            const piece = item.piece;

            const itemGroup = new graphic.Group();
            itemGroup.onclick = zrUtil.bind(this._onItemClick, this, piece);

            this._enableHoverLink(itemGroup, item.indexInModelPieceList);

            // TODO Category
            const representValue = visualMapModel.getRepresentValue(piece) as number;

            this._createItemSymbol(
                itemGroup, representValue, [0, 0, itemSize[0], itemSize[1]], silent
            );

            if (showLabel) {
                const visualState = this.visualMapModel.getValueState(representValue);
                const align = textStyleModel.get('align') || itemAlign as TextAlign;
                itemGroup.add(new graphic.Text({
                    style: createTextStyle(textStyleModel, {
                        x: align === 'right' ? -textGap : itemSize[0] + textGap,
                        y: itemSize[1] / 2,
                        text: piece.text,
                        verticalAlign: textStyleModel.get('verticalAlign') || 'middle',
                        align,
                        opacity: zrUtil.retrieve2(
                            textStyleModel.get('opacity'),
                            visualState === 'outOfRange' ? 0.5 : 1
                        ),
                    }),
                    silent
                }));
            }

            thisGroup.add(itemGroup);
        }, this);

        endsText && this._renderEndsText(
            thisGroup, endsText[1], itemSize, showLabel, itemAlign
        );

        layout.box(
            visualMapModel.get('orient'), thisGroup, visualMapModel.get('itemGap')
        );

        this.renderBackground(thisGroup);

        this.positionGroup(thisGroup);
    }

    protected _enableHoverLink(itemGroup: graphic.Group, pieceIndex: number) {
        itemGroup
            .on('mouseover', () => onHoverLink('highlight'))
            .on('mouseout', () => onHoverLink('downplay'));

        const onHoverLink = (method?: 'highlight' | 'downplay') => {
            const visualMapModel = this.visualMapModel;

            // TODO: TYPE More detailed action types
            visualMapModel.option.hoverLink && this.api.dispatchAction({
                type: method,
                batch: helper.makeHighDownBatch(
                    visualMapModel.findTargetDataIndices(pieceIndex),
                    visualMapModel
                )
            });
        };
    }

    protected _getItemAlign(): 'left' | 'right' {
        const visualMapModel = this.visualMapModel;
        const modelOption = visualMapModel.option;

        // if (modelOption.orient === 'vertical') {
        //     return helper.getItemAlign(
        //         visualMapModel, this.api, visualMapModel.itemSize
        //     );
        // }
        // else { // horizontal, most case left unless specifying right.
            let align = modelOption.align;
            if (!align || align === 'auto') {
                align = 'left';
            }
            return align;
        // }
    }

    protected _renderEndsText(
        group: graphic.Group,
        text: string,
        itemSize: number[],
        showLabel: boolean,
        itemAlign: helper.ItemAlign
    ) {
        if (!text) {
            return;
        }

        const itemGroup = new graphic.Group();
        const textStyleModel = this.visualMapModel.textStyleModel;

        itemGroup.add(new graphic.Text({
            style: createTextStyle(textStyleModel, {
                x: showLabel ? (itemAlign === 'right' ? itemSize[0] : 0) : itemSize[0] / 2,
                y: itemSize[1] / 2,
                verticalAlign: 'middle',
                align: showLabel ? (itemAlign as TextAlign) : 'center',
                text
            })
        }));

        group.add(itemGroup);
    }

    /**
     * @private
     * @return {Object} {peiceList, endsText} The order is the same as screen pixel order.
     */
    protected _getViewData():any {
        const visualMapModel = this.visualMapModel;

        const viewPieceList = zrUtil.map(visualMapModel.getPieceList(), function (piece, index) {
            return {piece: piece, indexInModelPieceList: index};
        });
        let endsText = visualMapModel.get('text');

        // Consider orient and inverse.
        const orient = visualMapModel.get('orient');
        const inverse = visualMapModel.get('inverse');

        // Order of model pieceList is always [low, ..., high]
        if (orient === 'horizontal' ? inverse : !inverse) {
            viewPieceList.reverse();
        }
        // Origin order of endsText is [high, low]
        else if (endsText) {
            endsText = endsText.slice().reverse();
        }

        return {viewPieceList: viewPieceList, endsText: endsText};
    }

    protected _createItemSymbol(
        group: graphic.Group,
        representValue: number,
        shapeParam: number[],
        silent?: boolean,
    ) {
        const itemSymbol = createSymbol(
            // symbol will be string
            this.getControllerVisual(representValue, 'symbol') as string,
            shapeParam[0], shapeParam[1], shapeParam[2], shapeParam[3],
            // color will be string
            this.getControllerVisual(representValue, 'color') as string
        );
        itemSymbol.silent = silent;
        group.add(itemSymbol);
    }

    protected _onItemClick(
        piece: VisualMappingOption['pieceList'][number]
    ) {
        const visualMapModel = this.visualMapModel;
        const option = visualMapModel.option;
        const selectedMode = option.selectedMode;
        if (!selectedMode) {
            return;
        }
        const selected = zrUtil.clone(option.selected);
        const newKey = visualMapModel.getSelectedMapKey(piece);

        if (selectedMode === 'single' || selectedMode === true) {
            selected[newKey] = true;
            zrUtil.each(selected, function (o, key) {
                selected[key] = key === newKey;
            });
        }
        else {
            selected[newKey] = !selected[newKey];
        }

        this.api.dispatchAction({
            type: 'selectDataRange',
            from: this.uid,
            visualMapId: this.visualMapModel.id,
            selected: selected
        });
    }

    /**
     * @override
     */
    renderForEstimate(visualMapModel: PiecewiseModel, ecModel: GlobalModel, api: ExtensionAPI): ZRRectLike {
        // 如果设置了不显示，则直接返回零矩形
        if (visualMapModel.get('show') === false) {
            return { x: 0, y: 0, width: 0, height: 0 };
        }

        // 创建临时 group，其内容仅供尺寸测量，不参与实际渲染
        const tempGroup = new graphic.Group();

        // 备份当前的 visualMapModel，防止状态被影响
        const originalVisualMapModel = this.visualMapModel;

        try {
            // 临时切换为用于估算的 visualMapModel
            this.visualMapModel = visualMapModel;

            // 创建一套透明的渲染内容，结构与正常渲染保持一致
            this._doRenderForEstimate(tempGroup, visualMapModel, ecModel, api);

            // 使用产品中同样的布局逻辑，保证尺寸一致性
            layout.box(
                visualMapModel.get('orient'), tempGroup, visualMapModel.get('itemGap')
            );

            // 获取当前 group 的包围盒
            const layoutRect = tempGroup.getBoundingRect();

            // 根据 model 配置的 padding 调整，得到最终预估尺寸
            return applyPaddingToRect(layoutRect, visualMapModel);
        }
        finally {
            // 恢复原有 visualMapModel，防止后续逻辑混乱
            this.visualMapModel = originalVisualMapModel;
        }
    }

    /**
     * 渲染一套仅用于尺寸估算的透明内容，结构应与正常渲染逻辑一致。
     *
     * 主要思路：用透明文本及 symbol 复现实际结构，便于外部准确获取尺寸。
     */
    private _doRenderForEstimate(
        targetGroup: graphic.Group,
        visualMapModel: PiecewiseModel,
        ecModel: GlobalModel,
        api: ExtensionAPI
    ): void {
        const textGap = visualMapModel.get('textGap');
        const textStyleModel = visualMapModel.textStyleModel;
        const itemAlign = this._getItemAlign();
        const itemSize = visualMapModel.itemSize;
        const viewData = this._getViewData();
        const endsText = viewData.endsText;
        // showLabel 优先使用用户配置，否则根据两端文本自动判断
        const showLabel = zrUtil.retrieve(visualMapModel.get('showLabel', true), !endsText);

        // 如果存在两端标签文本，则绘制透明文本，仅影响布局，不被感知
        endsText && this._renderEndsTextForEstimate(
            targetGroup, endsText[0], itemSize, showLabel, itemAlign
        );

        // 为每一个 piece 创建 itemGroup，一个 piece 代表图例的一个区间
        zrUtil.each(viewData.viewPieceList, function (item: typeof viewData.viewPieceList[number]) {
            const piece = item.piece;

            const itemGroup = new graphic.Group();
            // 估算模式下无需添加事件，纯布局结构

            // 获取该 piece 的代表值，用于创建 symbol
            const representValue = visualMapModel.getRepresentValue(piece) as number;

            // 创建透明图例符号（symbol），融入布局但不可见
            this._createItemSymbolForEstimate(
                itemGroup, representValue, [0, 0, itemSize[0], itemSize[1]]
            );

            // 如启用标签，绘制透明文本。确保最终布局和视觉实际一致
            if (showLabel) {
                const align = textStyleModel.get('align') || itemAlign as TextAlign;
                itemGroup.add(new graphic.Text({
                    style: createTextStyle(textStyleModel, {
                        x: align === 'right' ? -textGap : itemSize[0] + textGap,
                        y: itemSize[1] / 2,
                        text: piece.text,
                        verticalAlign: textStyleModel.get('verticalAlign') || 'middle',
                        align,
                        fill: 'transparent',
                        opacity: 0    // 内容透明，不可见
                    }),
                    silent: true
                }));
            }

            // 添加到整体 group，便于统一布局
            targetGroup.add(itemGroup);
        }, this);

        // 补充渲染末端透明文本，保证估算结构与真实一致
        endsText && this._renderEndsTextForEstimate(
            targetGroup, endsText[1], itemSize, showLabel, itemAlign
        );
    }

    /**
     * 渲染图例一端（两端）的透明说明文本，专为尺寸估算用途只生成布局使用的对
     * 象，不参与交互，也不会出现在最终页面。
     */
    protected _renderEndsTextForEstimate(
        group: graphic.Group,
        text: string,
        itemSize: number[],
        showLabel: boolean,
        itemAlign: helper.ItemAlign
    ) {
        if (!text) {
            return;
        }

        const itemGroup = new graphic.Group();
        const textStyleModel = this.visualMapModel.textStyleModel;

        // x 位置和 align 根据是否显示标签动态调整，模拟实际布局差异
        itemGroup.add(new graphic.Text({
            style: createTextStyle(textStyleModel, {
                x: showLabel ? (itemAlign === 'right' ? itemSize[0] : 0) : itemSize[0] / 2,
                y: itemSize[1] / 2,
                verticalAlign: 'middle',
                align: showLabel ? (itemAlign as TextAlign) : 'center',
                text,
                fill: 'transparent',
                opacity: 0    // 真实不可见，仅占位
            }),
            silent: true
        }));

        group.add(itemGroup);
    }

    /**
     * 创建透明的图例符号，仅用于总尺寸估算（例如自适应布局）其样式与真实内容保
     * 持一致，但始终不可见。
     */
    protected _createItemSymbolForEstimate(
        group: graphic.Group,
        representValue: number,
        shapeParam: number[]
    ) {
        const itemSymbol = createSymbol(
            // symbol 配置取自控制器视觉（一般为字符串）
            this.getControllerVisual(representValue, 'symbol') as string,
            shapeParam[0], shapeParam[1], shapeParam[2], shapeParam[3],
            // color 同理，仅用于结构一致，不显示
            this.getControllerVisual(representValue, 'color') as string
        );
        itemSymbol.silent = true;
        // 设置完全透明，fill 也透明，确保对布局有效对视觉无影响
        itemSymbol.setStyle({
            fill: 'transparent',
            opacity: 0
        });
        group.add(itemSymbol);
    }
}

export default PiecewiseVisualMapView;
