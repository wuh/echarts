import Group from 'zrender/src/graphic/Group';
import PiecewiseVisualMapView from './PiecewiseView';
import * as layoutUtil from '../../util/layout';
import ScrollablePiecewiseModel, { ScrollablePiecewiseVisualMapOption } from './ScrollablePiecewiseModel';
import * as zrUtil from 'zrender/src/core/util';
import * as graphic from '../../util/graphic';
import { TextAlign } from 'zrender/src/core/types';
import ExtensionAPI from '../../core/ExtensionAPI';
import GlobalModel from '../../model/Global';
import Element from 'zrender/src/Element';
import { ZRRectLike } from '../../util/types';
import Displayable from 'zrender/src/graphic/Displayable';

const WH = ['width', 'height'] as const;
const XY = ['x', 'y'] as const;

interface PageInfo {
    contentPosition: number[]
    pageCount: number
    pageIndex: number
    pagePrevDataIndex: number
    pageNextDataIndex: number
}

interface ItemInfo {
    /**
     * Start
     */
    s: number
    /**
     * End
     */
    e: number
    /**
     * Index
     */
    i: number
}

type VisualMapItemElement = Element & {
    __visualMapDataIndex: number
};

type VisualMapGroup = graphic.Group & {
    __rectSize: number
};

export class ScrollablePiecewiseView extends PiecewiseVisualMapView {

    static type = 'visualMap.scrollPiecewise' as const;
    type = ScrollablePiecewiseView.type;

    private _containerGroup: VisualMapGroup;
    private _contentGroup: graphic.Group;
    private _controllerGroup: graphic.Group;

    visualMapModel: ScrollablePiecewiseModel;


    private _currentIndex: number = 0;

    private _showController: boolean;

    /**
     * If first rendering, `contentGroup.position` is [0, 0], which
     * does not make sense and may cause unexpected animation if adopted.
     */
    private _isFirstRender: boolean;

    init(ecModel: GlobalModel, api: ExtensionAPI): void {
        super.init(ecModel, api);
        this._isFirstRender = true;
    }

    protected doRender(
        visualMapModel: ScrollablePiecewiseModel,
        ecModel: GlobalModel,
        api: ExtensionAPI,
        payload: unknown) {
        const thisGroup = this.group;
        const isFirstRender = this._isFirstRender;
        this._isFirstRender = false;

        if (!this._containerGroup) {
            thisGroup.add(this._containerGroup = new Group() as VisualMapGroup);
            this._containerGroup.add(this._contentGroup = new Group());
            thisGroup.add(this._controllerGroup = new Group());
        }
        else {
            /** 不能把group都删掉，这会导致翻页时总是从left:0开始动画 */
            this._contentGroup.removeAll();
            this._controllerGroup.removeAll();
            this._containerGroup.removeClipPath();
            this._containerGroup.__rectSize = null;
            this._backgroundEl && this.group.remove(this._backgroundEl);
        }

        const itemAlign = this._getItemAlign();
        const itemSize = visualMapModel.itemSize;
        const viewData = this._getViewData();
        const endsText = viewData.endsText;
        const showLabel = zrUtil.retrieve(visualMapModel.get('showLabel', true), !endsText);

        endsText && this._renderEndsText(
            thisGroup, endsText[0], itemSize, showLabel, itemAlign
        );

        this.renderContent(visualMapModel, api);

        // Perform layout.
        const positionInfo = visualMapModel.getBoxLayoutParams();
        const viewportSize = { width: api.getWidth(), height: api.getHeight() };
        const padding = visualMapModel.get('padding');

        const maxSize = layoutUtil.getLayoutRect(positionInfo, viewportSize, padding);

        const mainRect = this.layoutContent(visualMapModel, itemAlign, maxSize, isFirstRender);

        // Place mainGroup, based on the calculated `mainRect`.
        const layoutRect = layoutUtil.getLayoutRect(
            zrUtil.defaults({
                width: mainRect.width,
                height: mainRect.height
            }, positionInfo),
            viewportSize,
            padding
        );
        this.group.x = layoutRect.x - mainRect.x;
        this.group.y = layoutRect.y - mainRect.y;

        endsText && this._renderEndsText(
            this._contentGroup, endsText[1], itemSize, showLabel, itemAlign
        );

        layoutUtil.box(
            visualMapModel.get('orient'), this._contentGroup, visualMapModel.get('itemGap')
        );

        this.group.markRedraw();

        this.renderBackground(thisGroup);

        // this.positionGroup(thisGroup);
    }

    private renderContent(visualMapModel: ScrollablePiecewiseModel, api: ExtensionAPI) {
        const textGap = visualMapModel.get('textGap');
        const textStyleModel = visualMapModel.textStyleModel;
        const textFont = textStyleModel.getFont();
        const textFill = textStyleModel.getTextColor();
        const itemAlign = this._getItemAlign();
        const itemSize = visualMapModel.itemSize;
        const viewData = this._getViewData();
        const endsText = viewData.endsText;
        const showLabel = zrUtil.retrieve(visualMapModel.get('showLabel', true), !endsText);
        const silent = !visualMapModel.get('selectedMode');

        zrUtil.each(viewData.viewPieceList, function (item: typeof viewData.viewPieceList[number], i) {
            const piece = item.piece;

            const itemGroup = new graphic.Group();
            // @ts-ignore
            itemGroup.__visualMapDataIndex = i;
            itemGroup.onclick = zrUtil.bind(this._onItemClick, this, piece);

            this._enableHoverLink(itemGroup, item.indexInModelPieceList);

            // TODO Category
            const representValue = visualMapModel.getRepresentValue(piece) as number;

            this._createItemSymbol(
                itemGroup, representValue, [0, 0, itemSize[0], itemSize[1]], silent
            );

            if (showLabel) {
                const visualState = this.visualMapModel.getValueState(representValue);
                itemGroup.add(new graphic.Text({
                    style: {
                        x: itemAlign === 'right' ? -textGap : itemSize[0] + textGap,
                        y: itemSize[1] / 2,
                        text: piece.text,
                        verticalAlign: 'middle',
                        align: itemAlign as TextAlign,
                        font: textFont,
                        fill: textFill,
                        opacity: visualState === 'outOfRange' ? 0.5 : 1,
                    },
                    silent
                }));
            }

            this._contentGroup.add(itemGroup);
        }, this);

        this.renderPage(api);
    }

    private renderPage(api: ExtensionAPI) {
        const self = this;

        const controllerGroup = this._controllerGroup;
        const visualMapModel = this.visualMapModel;
        // FIXME: support be 'auto' adapt to size number text length,
        // e.g., '3/12345' should not overlap with the control arrow button.
        const pageIconSize = visualMapModel.get('pageIconSize', true);
        const pageIconSizeArr: number[] = zrUtil.isArray(pageIconSize)
            ? pageIconSize : [pageIconSize, pageIconSize];

        createPageButton('pagePrev', 0);

        const pageTextStyleModel = visualMapModel.getModel('pageTextStyle');
        controllerGroup.add(new graphic.Text({
            name: 'pageText',
            style: {
                // Placeholder to calculate a proper layout.
                text: 'xx/xx',
                fill: pageTextStyleModel.getTextColor(),
                font: pageTextStyleModel.getFont(),
                verticalAlign: 'middle',
                align: 'center'
            },
            silent: true
        }));

        createPageButton('pageNext', 1);

        function createPageButton(name: string, iconIdx: number) {
            const pageDataIndexName = (name + 'DataIndex') as 'pagePrevDataIndex' | 'pageNextDataIndex';
            const icon = graphic.createIcon(
                visualMapModel.get('pageIcons', true)[visualMapModel.get('orient')][iconIdx],
                {
                    // Buttons will be created in each render, so we do not need
                    // to worry about avoiding using visualMapModel kept in scope.
                    onclick: zrUtil.bind(
                        self._pageGo, self, pageDataIndexName, visualMapModel, api
                    )
                },
                {
                    x: -pageIconSizeArr[0] / 2,
                    y: -pageIconSizeArr[1] / 2,
                    width: pageIconSizeArr[0],
                    height: pageIconSizeArr[1]
                }
            );
            icon.name = name;
            controllerGroup.add(icon);
        }
    }

    private layoutContent(
        visualMapModel: ScrollablePiecewiseModel,
        itemAlign: ScrollablePiecewiseVisualMapOption['align'],
        maxSize: { width: number, height: number },
        isFirstRender: boolean
    ) {

        const orient = visualMapModel.get('orient');
        const orientIdx = orient === 'vertical' ? 1 : 0;
        const wh = WH[orientIdx];
        const xy = XY[orientIdx];
        const hw = WH[1 - orientIdx];
        const yx = XY[1 - orientIdx];

        const processMaxSize = zrUtil.clone(maxSize);

        const mainRect = this._layoutContentAndController(visualMapModel, isFirstRender,
            processMaxSize, orientIdx, wh, hw, yx, xy
        );

        return mainRect;
    }

    public _layoutContentAndController(
        visualMapModel: ScrollablePiecewiseModel,
        isFirstRender: boolean,
        maxSize: { width: number, height: number },
        orientIdx: 0 | 1,
        wh: 'width' | 'height',
        hw: 'width' | 'height',
        yx: 'x' | 'y',
        xy: 'y' | 'x'
    ) {
        const contentGroup = this._contentGroup;
        const containerGroup = this._containerGroup;
        const controllerGroup = this._controllerGroup;

        // Place items in contentGroup.
        layoutUtil.box(
            visualMapModel.get('orient'),
            contentGroup,
            visualMapModel.get('itemGap'),
            !orientIdx ? null : maxSize.width,
            orientIdx ? null : maxSize.height
        );

        layoutUtil.box(
            // Buttons in controller are layout always horizontally.
            'horizontal',
            controllerGroup,
            visualMapModel.get('pageButtonItemGap', true)
        );

        const contentRect = contentGroup.getBoundingRect();
        const controllerRect = controllerGroup.getBoundingRect();
        const showController = this._showController = contentRect[wh] > maxSize[wh];

        // In case that the inner elements of contentGroup layout do not based on [0, 0]
        const contentPos = [-contentRect.x, -contentRect.y];
        // Remain contentPos when scroll animation perfroming.
        // If first rendering, `contentGroup.position` is [0, 0], which
        // does not make sense and may cause unexepcted animation if adopted.
        if (!isFirstRender) {
            contentPos[orientIdx] = contentGroup[xy];
        }

        // Layout container group based on 0.
        const containerPos = [0, 0];
        const controllerPos = [-controllerRect.x, -controllerRect.y];
        const pageButtonGap = zrUtil.retrieve2(
            visualMapModel.get('pageButtonGap', true), visualMapModel.get('itemGap', true)
        );

        // Place containerGroup and controllerGroup and contentGroup.
        if (showController) {
            const pageButtonPosition = visualMapModel.get('pageButtonPosition', true);
            // controller is on the right / bottom.
            if (pageButtonPosition === 'end') {
                controllerPos[orientIdx] += maxSize[wh] - controllerRect[wh];
            }
            // controller is on the left / top.
            else {
                containerPos[orientIdx] += controllerRect[wh] + pageButtonGap;
            }
        }

        // Always align controller to content as 'middle'.
        controllerPos[1 - orientIdx] += contentRect[hw] / 2 - controllerRect[hw] / 2;

        contentGroup.setPosition(contentPos);
        containerGroup.setPosition(containerPos);
        controllerGroup.setPosition(controllerPos);

        // Calculate `mainRect` and set `clipPath`.
        // mainRect should not be calculated by `this.group.getBoundingRect()`
        // for sake of the overflow.
        const mainRect = { x: 0, y: 0 } as ZRRectLike;

        // Consider content may be overflow (should be clipped).
        mainRect[wh] = showController ? maxSize[wh] : contentRect[wh];
        mainRect[hw] = Math.max(contentRect[hw], controllerRect[hw]);

        // `containerRect[yx] + containerPos[1 - orientIdx]` is 0.
        mainRect[yx] = Math.min(0, controllerRect[yx] + controllerPos[1 - orientIdx]);

        containerGroup.__rectSize = maxSize[wh];
        if (showController) {
            const clipShape = { x: 0, y: 0 } as graphic.Rect['shape'];
            clipShape[wh] = Math.max(maxSize[wh] - controllerRect[wh] - pageButtonGap, 0);
            clipShape[hw] = mainRect[hw];
            containerGroup.setClipPath(new graphic.Rect({ shape: clipShape }));
            // Consider content may be larger than container, container rect
            // can not be obtained from `containerGroup.getBoundingRect()`.
            containerGroup.__rectSize = clipShape[wh];
        }
        else {
            // Do not remove or ignore controller. Keep them set as placeholders.
            controllerGroup.eachChild(function (child: Displayable) {
                child.attr({
                    invisible: true,
                    silent: true
                });
            });
        }

        // Content translate animation.
        const pageInfo = this._getPageInfo(visualMapModel);
        pageInfo.pageIndex != null && graphic.updateProps(
            contentGroup,
            { x: pageInfo.contentPosition[0], y: pageInfo.contentPosition[1] },
            // When switch from "show controller" to "not show controller", view should be
            // updated immediately without animation, otherwise causes weird effect.
            showController ? visualMapModel : null
        );

        this._updatePageInfoView(visualMapModel, pageInfo);

        return mainRect;
    }

    _pageGo(
        to: 'pagePrevDataIndex' | 'pageNextDataIndex',
        visualMapModel: ScrollablePiecewiseModel,
        api: ExtensionAPI
    ) {
        const scrollDataIndex = this._getPageInfo(visualMapModel)[to];

        scrollDataIndex != null && api.dispatchAction({
            type: 'visualMapScroll',
            scrollDataIndex: scrollDataIndex,
            visualMapId: visualMapModel.id
        });
    }

    _updatePageInfoView(
        visualMapModel: ScrollablePiecewiseModel,
        pageInfo: PageInfo
    ) {
        const controllerGroup = this._controllerGroup;

        zrUtil.each(['pagePrev', 'pageNext'], function (name) {
            const key = (name + 'DataIndex') as 'pagePrevDataIndex' | 'pageNextDataIndex';
            const canJump = pageInfo[key] != null;
            const icon = controllerGroup.childOfName(name) as graphic.Path;
            if (icon) {
                icon.setStyle(
                    'fill',
                    canJump
                        ? visualMapModel.get('pageIconColor', true)
                        : visualMapModel.get('pageIconInactiveColor', true)
                );
                icon.cursor = canJump ? 'pointer' : 'default';
            }
        });

        const pageText = controllerGroup.childOfName('pageText') as graphic.Text;
        const pageFormatter = visualMapModel.get('pageFormatter');
        const pageIndex = pageInfo.pageIndex;
        const current = pageIndex != null ? pageIndex + 1 : 0;
        const total = pageInfo.pageCount;

        pageText && pageFormatter && pageText.setStyle(
            'text',
            zrUtil.isString(pageFormatter)
                ? pageFormatter.replace('{current}', current == null ? '' : current + '')
                    .replace('{total}', total == null ? '' : total + '')
                : pageFormatter({ current: current, total: total })
        );
    }

    /**
     *  contentPosition: Array.<number>, null when data item not found.
     *  pageIndex: number, null when data item not found.
     *  pageCount: number, always be a number, can be 0.
     *  pagePrevDataIndex: number, null when no previous page.
     *  pageNextDataIndex: number, null when no next page.
     * }
     */
    _getPageInfo(visualMapModel: ScrollablePiecewiseModel): PageInfo {
        const scrollDataIndex = visualMapModel.get('scrollDataIndex', true);
        const contentGroup = this._contentGroup;
        const containerRectSize = this._containerGroup.__rectSize;
        const orient = visualMapModel.get('orient');
        const orientIdx = orient === 'vertical' ? 1 : 0;
        const wh = WH[orientIdx];
        const xy = XY[orientIdx];

        const targetItemIndex = this._findTargetItemIndex(scrollDataIndex);
        const children = contentGroup.children();
        const targetItem = children[targetItemIndex];
        const itemCount = children.length;
        const pCount = !itemCount ? 0 : 1;

        const result: PageInfo = {
            contentPosition: [contentGroup.x, contentGroup.y],
            pageCount: pCount,
            pageIndex: pCount - 1,
            pagePrevDataIndex: null,
            pageNextDataIndex: null
        };

        if (!targetItem) {
            return result;
        }

        const targetItemInfo = getItemInfo(targetItem);
        result.contentPosition[orientIdx] = -targetItemInfo.s;

        // Strategy:
        // (1) Always align based on the left/top most item.
        // (2) It is user-friendly that the last item shown in the
        // current window is shown at the begining of next window.
        // Otherwise if half of the last item is cut by the window,
        // it will have no chance to display entirely.
        // (3) Consider that item size probably be different, we
        // have calculate pageIndex by size rather than item index,
        // and we can not get page index directly by division.
        // (4) The window is to narrow to contain more than
        // one item, we should make sure that the page can be fliped.

        for (let i = targetItemIndex + 1,
            winStartItemInfo = targetItemInfo,
            winEndItemInfo = targetItemInfo,
            currItemInfo = null;
            i <= itemCount;
            ++i
        ) {
            currItemInfo = getItemInfo(children[i]);
            if (
                // Half of the last item is out of the window.
                (!currItemInfo && winEndItemInfo.e > winStartItemInfo.s + containerRectSize)
                // If the current item does not intersect with the window, the new page
                // can be started at the current item or the last item.
                || (currItemInfo && !intersect(currItemInfo, winStartItemInfo.s))
            ) {
                if (winEndItemInfo.i > winStartItemInfo.i) {
                    winStartItemInfo = winEndItemInfo;
                }
                else { // e.g., when page size is smaller than item size.
                    winStartItemInfo = currItemInfo;
                }
                if (winStartItemInfo) {
                    if (result.pageNextDataIndex == null) {
                        result.pageNextDataIndex = winStartItemInfo.i;
                    }
                    ++result.pageCount;
                }
            }
            winEndItemInfo = currItemInfo;
        }

        for (let i = targetItemIndex - 1,
            winStartItemInfo = targetItemInfo,
            winEndItemInfo = targetItemInfo,
            currItemInfo = null;
            i >= -1;
            --i
        ) {
            currItemInfo = getItemInfo(children[i]);
            if (
                // If the the end item does not intersect with the window started
                // from the current item, a page can be settled.
                (!currItemInfo || !intersect(winEndItemInfo, currItemInfo.s))
                // e.g., when page size is smaller than item size.
                && winStartItemInfo.i < winEndItemInfo.i
            ) {
                winEndItemInfo = winStartItemInfo;
                if (result.pagePrevDataIndex == null) {
                    result.pagePrevDataIndex = winStartItemInfo.i;
                }
                ++result.pageCount;
                ++result.pageIndex;
            }
            winStartItemInfo = currItemInfo;
        }

        return result;

        function getItemInfo(el: Element): ItemInfo {
            if (el) {
                const itemRect = el.getBoundingRect();
                const start = itemRect[xy] + el[xy];
                return {
                    s: start,
                    e: start + itemRect[wh],
                    i: (el as VisualMapItemElement).__visualMapDataIndex
                };
            }
        }

        function intersect(itemInfo: ItemInfo, winStart: number) {
            return itemInfo.e >= winStart && itemInfo.s <= winStart + containerRectSize;
        }
    }

    _findTargetItemIndex(targetDataIndex: number) {
        if (!this._showController) {
            return 0;
        }

        let index;
        const contentGroup = this._contentGroup;
        let defaultIndex: number;

        contentGroup.eachChild(function (child, idx) {
            const itemDataIdx = (child as VisualMapItemElement).__visualMapDataIndex;
            // FIXME
            // If the given targetDataIndex (from model) is illegal,
            // we use defaultIndex. But the index on the visualmap model and
            // action payload is still illegal. That case will not be
            // changed until some scenario requires.
            if (defaultIndex == null && itemDataIdx != null) {
                defaultIndex = idx;
            }
            if (itemDataIdx === targetDataIndex) {
                index = idx;
            }
        });

        return index != null ? index : defaultIndex;
    }
}

export default ScrollablePiecewiseView;