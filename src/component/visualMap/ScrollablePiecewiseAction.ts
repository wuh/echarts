
import ScrollablePiecewiseModel from './ScrollablePiecewiseModel';
import { EChartsExtensionInstallRegisters } from '../../extension';

export default function installScrollablePiecewiseAction(registers: EChartsExtensionInstallRegisters) {
    /**
     * @event visualMapScroll
     * @type {Object}
     * @property {string} type 'visualMapScroll'
     * @property {string} scrollDataIndex
     */
    registers.registerAction(
        'visualMapScroll', 'visualmapscroll',
        function (payload, ecModel) {
            const scrollDataIndex = payload.scrollDataIndex;

            scrollDataIndex != null && ecModel.eachComponent(
                { mainType: 'visualMap', subType: 'scrollPiecewise', query: payload },
                function (visualMapModel: ScrollablePiecewiseModel) {
                    visualMapModel.setScrollDataIndex(scrollDataIndex);
                }
            );
        }
    );
}