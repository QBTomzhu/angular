import * as o from '../output/output_ast';
import { Identifiers } from '../identifiers';
import { DetectChangesVars } from './constants';
import { PropertyBindingType } from '../template_ast';
import { isBlank, isPresent } from 'angular2/src/facade/lang';
import { LifecycleHooks } from 'angular2/src/core/metadata/lifecycle_hooks';
import { isDefaultChangeDetectionStrategy } from 'angular2/src/core/change_detection/constants';
import { camelCaseToDashCase } from '../util';
import { convertCdExpressionToIr } from './expression_converter';
import { CompileBinding } from './compile_binding';
function createBindFieldExpr(exprIndex) {
    return o.THIS_EXPR.prop(`_expr_${exprIndex}`);
}
function createCurrValueExpr(exprIndex) {
    return o.variable(`currVal_${exprIndex}`);
}
function bind(view, currValExpr, fieldExpr, parsedExpression, context, actions, method) {
    var checkExpression = convertCdExpressionToIr(view, context, parsedExpression, DetectChangesVars.valUnwrapper);
    if (isBlank(checkExpression.expression)) {
        // e.g. an empty expression was given
        return;
    }
    view.fields.push(new o.ClassField(fieldExpr.name, null, [o.StmtModifier.Private]));
    view.createMethod.addStmt(o.THIS_EXPR.prop(fieldExpr.name).set(o.importExpr(Identifiers.uninitialized)).toStmt());
    if (checkExpression.needsValueUnwrapper) {
        var initValueUnwrapperStmt = DetectChangesVars.valUnwrapper.callMethod('reset', []).toStmt();
        method.addStmt(initValueUnwrapperStmt);
    }
    method.addStmt(currValExpr.set(checkExpression.expression).toDeclStmt(null, [o.StmtModifier.Final]));
    var condition = o.importExpr(Identifiers.checkBinding)
        .callFn([DetectChangesVars.throwOnChange, fieldExpr, currValExpr]);
    if (checkExpression.needsValueUnwrapper) {
        condition = DetectChangesVars.valUnwrapper.prop('hasWrappedValue').or(condition);
    }
    method.addStmt(new o.IfStmt(condition, actions.concat([o.THIS_EXPR.prop(fieldExpr.name).set(currValExpr).toStmt()])));
}
export function bindRenderText(boundText, compileNode, view) {
    var bindingIndex = view.bindings.length;
    view.bindings.push(new CompileBinding(compileNode, boundText));
    var currValExpr = createCurrValueExpr(bindingIndex);
    var valueField = createBindFieldExpr(bindingIndex);
    view.detectChangesRenderPropertiesMethod.resetDebugInfo(compileNode.nodeIndex, boundText);
    bind(view, currValExpr, valueField, boundText.value, o.THIS_EXPR.prop('context'), [
        o.THIS_EXPR.prop('renderer')
            .callMethod('setText', [compileNode.renderNode, currValExpr])
            .toStmt()
    ], view.detectChangesRenderPropertiesMethod);
}
function bindAndWriteToRenderer(boundProps, context, compileElement) {
    var view = compileElement.view;
    var renderNode = compileElement.renderNode;
    boundProps.forEach((boundProp) => {
        var bindingIndex = view.bindings.length;
        view.bindings.push(new CompileBinding(compileElement, boundProp));
        view.detectChangesRenderPropertiesMethod.resetDebugInfo(compileElement.nodeIndex, boundProp);
        var fieldExpr = createBindFieldExpr(bindingIndex);
        var currValExpr = createCurrValueExpr(bindingIndex);
        var renderMethod;
        var renderValue = currValExpr;
        var updateStmts = [];
        switch (boundProp.type) {
            case PropertyBindingType.Property:
                renderMethod = 'setElementProperty';
                if (view.genConfig.logBindingUpdate) {
                    updateStmts.push(logBindingUpdateStmt(renderNode, boundProp.name, currValExpr));
                }
                break;
            case PropertyBindingType.Attribute:
                renderMethod = 'setElementAttribute';
                renderValue =
                    renderValue.isBlank().conditional(o.NULL_EXPR, renderValue.callMethod('toString', []));
                break;
            case PropertyBindingType.Class:
                renderMethod = 'setElementClass';
                break;
            case PropertyBindingType.Style:
                renderMethod = 'setElementStyle';
                var strValue = renderValue.callMethod('toString', []);
                if (isPresent(boundProp.unit)) {
                    strValue = strValue.plus(o.literal(boundProp.unit));
                }
                renderValue = renderValue.isBlank().conditional(o.NULL_EXPR, strValue);
                break;
        }
        updateStmts.push(o.THIS_EXPR.prop('renderer')
            .callMethod(renderMethod, [renderNode, o.literal(boundProp.name), renderValue])
            .toStmt());
        bind(view, currValExpr, fieldExpr, boundProp.value, context, updateStmts, view.detectChangesRenderPropertiesMethod);
    });
}
export function bindRenderInputs(boundProps, compileElement) {
    bindAndWriteToRenderer(boundProps, o.THIS_EXPR.prop('context'), compileElement);
}
export function bindDirectiveHostProps(directiveAst, directiveInstance, compileElement) {
    bindAndWriteToRenderer(directiveAst.hostProperties, directiveInstance, compileElement);
}
export function bindDirectiveInputs(directiveAst, directiveInstance, compileElement) {
    if (directiveAst.inputs.length === 0) {
        return;
    }
    var view = compileElement.view;
    var detectChangesInInputsMethod = view.detectChangesInInputsMethod;
    detectChangesInInputsMethod.resetDebugInfo(compileElement.nodeIndex, compileElement.sourceAst);
    var lifecycleHooks = directiveAst.directive.lifecycleHooks;
    var calcChangesMap = lifecycleHooks.indexOf(LifecycleHooks.OnChanges) !== -1;
    var isOnPushComp = directiveAst.directive.isComponent &&
        !isDefaultChangeDetectionStrategy(directiveAst.directive.changeDetection);
    if (calcChangesMap) {
        detectChangesInInputsMethod.addStmt(DetectChangesVars.changes.set(o.NULL_EXPR).toStmt());
    }
    if (isOnPushComp) {
        detectChangesInInputsMethod.addStmt(DetectChangesVars.changed.set(o.literal(false)).toStmt());
    }
    directiveAst.inputs.forEach((input) => {
        var bindingIndex = view.bindings.length;
        view.bindings.push(new CompileBinding(compileElement, input));
        detectChangesInInputsMethod.resetDebugInfo(compileElement.nodeIndex, input);
        var fieldExpr = createBindFieldExpr(bindingIndex);
        var currValExpr = createCurrValueExpr(bindingIndex);
        var statements = [directiveInstance.prop(input.directiveName).set(currValExpr).toStmt()];
        if (calcChangesMap) {
            statements.push(new o.IfStmt(DetectChangesVars.changes.identical(o.NULL_EXPR), [
                DetectChangesVars.changes.set(o.literalMap([], new o.MapType(o.importType(Identifiers.SimpleChange))))
                    .toStmt()
            ]));
            statements.push(DetectChangesVars.changes.key(o.literal(input.directiveName))
                .set(o.importExpr(Identifiers.SimpleChange).instantiate([fieldExpr, currValExpr]))
                .toStmt());
        }
        if (isOnPushComp) {
            statements.push(DetectChangesVars.changed.set(o.literal(true)).toStmt());
        }
        if (view.genConfig.logBindingUpdate) {
            statements.push(logBindingUpdateStmt(compileElement.renderNode, input.directiveName, currValExpr));
        }
        bind(view, currValExpr, fieldExpr, input.value, o.THIS_EXPR.prop('context'), statements, detectChangesInInputsMethod);
    });
    if (isOnPushComp) {
        detectChangesInInputsMethod.addStmt(new o.IfStmt(DetectChangesVars.changed, [
            compileElement.appElement.prop('componentView')
                .callMethod('markAsCheckOnce', [])
                .toStmt()
        ]));
    }
}
function logBindingUpdateStmt(renderNode, propName, value) {
    return o.THIS_EXPR.prop('renderer')
        .callMethod('setBindingDebugInfo', [
        renderNode,
        o.literal(`ng-reflect-${camelCaseToDashCase(propName)}`),
        value.isBlank().conditional(o.NULL_EXPR, value.callMethod('toString', []))
    ])
        .toStmt();
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHJvcGVydHlfYmluZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiZGlmZmluZ19wbHVnaW5fd3JhcHBlci1vdXRwdXRfcGF0aC1WUFRyZFpJTy50bXAvYW5ndWxhcjIvc3JjL2NvbXBpbGVyL3ZpZXdfY29tcGlsZXIvcHJvcGVydHlfYmluZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJPQUNPLEtBQUssQ0FBQyxNQUFNLHNCQUFzQjtPQUNsQyxFQUFDLFdBQVcsRUFBQyxNQUFNLGdCQUFnQjtPQUNuQyxFQUFDLGlCQUFpQixFQUFDLE1BQU0sYUFBYTtPQUV0QyxFQUlMLG1CQUFtQixFQUVwQixNQUFNLGlCQUFpQjtPQUVqQixFQUFDLE9BQU8sRUFBRSxTQUFTLEVBQXNCLE1BQU0sMEJBQTBCO09BTXpFLEVBQUMsY0FBYyxFQUFDLE1BQU0sNENBQTRDO09BQ2xFLEVBQUMsZ0NBQWdDLEVBQUMsTUFBTSw4Q0FBOEM7T0FDdEYsRUFBQyxtQkFBbUIsRUFBQyxNQUFNLFNBQVM7T0FFcEMsRUFBQyx1QkFBdUIsRUFBQyxNQUFNLHdCQUF3QjtPQUV2RCxFQUFDLGNBQWMsRUFBQyxNQUFNLG1CQUFtQjtBQUVoRCw2QkFBNkIsU0FBaUI7SUFDNUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLFNBQVMsU0FBUyxFQUFFLENBQUMsQ0FBQztBQUNoRCxDQUFDO0FBRUQsNkJBQTZCLFNBQWlCO0lBQzVDLE1BQU0sQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFdBQVcsU0FBUyxFQUFFLENBQUMsQ0FBQztBQUM1QyxDQUFDO0FBRUQsY0FBYyxJQUFpQixFQUFFLFdBQTBCLEVBQUUsU0FBeUIsRUFDeEUsZ0JBQTJCLEVBQUUsT0FBcUIsRUFBRSxPQUFzQixFQUMxRSxNQUFxQjtJQUNqQyxJQUFJLGVBQWUsR0FDZix1QkFBdUIsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFLGdCQUFnQixFQUFFLGlCQUFpQixDQUFDLFlBQVksQ0FB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UyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsRUFBRSxVQUFVLEVBQ2xGLDJCQUEyQixDQUFDLENBQUM7SUFDcEMsQ0FBQyxDQUFDLENBQUM7SUFDSCxFQUFFLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDO1FBQ2pCLDJCQUEyQixDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsaUJBQWlCLENBQUMsT0FBTyxFQUFFO1lBQzFFLGNBQWMsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQztpQkFDMUMsVUFBVSxDQUFDLGlCQUFpQixFQUFFLEVBQUUsQ0FBQztpQkFDakMsTUFBTSxFQUFFO1NBQ2QsQ0FBQyxDQUFDLENBQUM7SUFDTixDQUFDO0FBQ0gsQ0FBQztBQUVELDhCQUE4QixVQUF3QixFQUFFLFFBQWdCLEVBQzFDLEtBQW1CO0lBQy9DLE1BQU0sQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUM7U0FDOUIsVUFBVSxDQUFDLHFCQUFxQixFQUNyQjtRQUNFLFVBQVU7UUFDVixDQUFDLENBQUMsT0FBTyxDQUFDLGNBQWMsbUJBQW1CLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztRQUN4RCxLQUFLLENBQUMsT0FBTyxFQUFFLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLFVBQVUsQ0FBQyxVQUFVLEVBQUUsRUFBRSxDQUFDLENBQUM7S0FDM0UsQ0FBQztTQUNiLE1BQU0sRUFBRSxDQUFDO0FBQ2hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZEFzdCBmcm9tICcuLi9leHByZXNzaW9uX3BhcnNlci9hc3QnO1xuaW1wb3J0ICogYXMgbyBmcm9tICcuLi9vdXRwdXQvb3V0cHV0X2FzdCc7XG5pbXBvcnQge0lkZW50aWZpZXJzfSBmcm9tICcuLi9pZGVudGlmaWVycyc7XG5pbXBvcnQge0RldGVjdENoYW5nZXNWYXJzfSBmcm9tICcuL2NvbnN0YW50cyc7XG5cbmltcG9ydCB7XG4gIEJvdW5kVGV4dEFzdCxcbiAgQm91bmRFbGVtZW50UHJvcGVydHlBc3QsXG4gIERpcmVjdGl2ZUFzdCxcbiAgUHJvcGVydHlCaW5kaW5nVHlwZSxcbiAgVGVtcGxhdGVBc3Rcbn0gZnJvbSAnLi4vdGVtcGxhdGVfYXN0JztcblxuaW1wb3J0IHtpc0JsYW5rLCBpc1ByZXNlbnQsIGlzQXJyYXksIENPTlNUX0VYUFJ9IGZyb20gJ2FuZ3VsYXIyL3NyYy9mYWNhZGUvbGFuZyc7XG5cbmltcG9ydCB7Q29tcGlsZVZpZXd9IGZyb20gJy4vY29tcGlsZV92aWV3JztcbmltcG9ydCB7Q29tcGlsZUVsZW1lbnQsIENvbXBpbGVOb2RlfSBmcm9tICcuL2NvbXBpbGVfZWxlbWVudCc7XG5pbXBvcnQge0NvbXBpbGVNZXRob2R9IGZyb20gJy4vY29tcGlsZV9tZXRob2QnO1xuXG5pbXBvcnQge0xpZmVjeWNsZUhvb2tzfSBmcm9tICdhbmd1bGFyMi9zcmMvY29yZS9tZXRhZGF0YS9saWZlY3ljbGVfaG9va3MnO1xuaW1wb3J0IHtpc0RlZmF1bHRDaGFuZ2VEZXRlY3Rpb25TdHJhdGVneX0gZnJvbSAnYW5ndWxhcjIvc3JjL2NvcmUvY2hhbmdlX2RldGVjdGlvbi9jb25zdGFudHMnO1xuaW1wb3J0IHtjYW1lbENhc2VUb0Rhc2hDYXNlfSBmcm9tICcuLi91dGlsJztcblxuaW1wb3J0IHtjb252ZXJ0Q2RFeHByZXNzaW9uVG9Jcn0gZnJvbSAnLi9leHByZXNzaW9uX2NvbnZlcnRlcic7XG5cbmltcG9ydCB7Q29tcGlsZUJpbmRpbmd9IGZyb20gJy4vY29tcGlsZV9iaW5kaW5nJztcblxuZnVuY3Rpb24gY3JlYXRlQmluZEZpZWxkRXhwcihleHBySW5kZXg6IG51bWJlcik6IG8uUmVhZFByb3BFeHByIHtcbiAgcmV0dXJuIG8uVEhJU19FWFBSLnByb3AoYF9leHByXyR7ZXhwckluZGV4fWApO1xufVxuXG5mdW5jdGlvbiBjcmVhdGVDdXJyVmFsdWVFeHByKGV4cHJJbmRleDogbnVtYmVyKTogby5SZWFkVmFyRXhwciB7XG4gIHJldHVybiBvLnZhcmlhYmxlKGBjdXJyVmFsXyR7ZXhwckluZGV4fWApO1xufVxuXG5mdW5jdGlvbiBiaW5kKHZpZXc6IENvbXBpbGVWaWV3LCBjdXJyVmFsRXhwcjogby5SZWFkVmFyRXhwciwgZmllbGRFeHByOiBvLlJlYWRQcm9wRXhwcixcbiAgICAgICAgICAgICAgcGFyc2VkRXhwcmVzc2lvbjogY2RBc3QuQVNULCBjb250ZXh0OiBvLkV4cHJlc3Npb24sIGFjdGlvbnM6IG8uU3RhdGVtZW50W10sXG4gICAgICAgICAgICAgIG1ldGhvZDogQ29tcGlsZU1ldGhvZCkge1xuICB2YXIgY2hlY2tFeHByZXNzaW9uID1cbiAgICAgIGNvbnZlcnRDZEV4cHJlc3Npb25Ub0lyKHZpZXcsIGNvbnRleHQsIHBhcnNlZEV4cHJlc3Npb24sIERldGVjdENoYW5nZXNWYXJzLnZhbFVud3JhcHBlcik7XG4gIGlmIChpc0JsYW5rKGNoZWNrRXhwcmVzc2lvbi5leHByZXNzaW9uKSkge1xuICAgIC8vIGUuZy4gYW4gZW1wdHkgZXhwcmVzc2lvbiB3YXMgZ2l2ZW5cbiAgICByZXR1cm47XG4gIH1cblxuICB2aWV3LmZpZWxkcy5wdXNoKG5ldyBvLkNsYXNzRmllbGQoZmllbGRFeHByLm5hbWUsIG51bGwsIFtvLlN0bXRNb2RpZmllci5Qcml2YXRlXSkpO1xuICB2aWV3LmNyZWF0ZU1ldGhvZC5hZGRTdG10KFxuICAgICAgby5USElTX0VYUFIucHJvcChmaWVsZEV4cHIubmFtZSkuc2V0KG8uaW1wb3J0RXhwcihJZGVudGlmaWVycy51bmluaXRpYWxpemVkKSkudG9TdG10KCkpO1xuXG4gIGlmIChjaGVja0V4cHJlc3Npb24ubmVlZHNWYWx1ZVVud3JhcHBlcikge1xuICAgIHZhciBpbml0VmFsdWVVbndyYXBwZXJTdG10ID0gRGV0ZWN0Q2hhbmdlc1ZhcnMudmFsVW53cmFwcGVyLmNhbGxNZXRob2QoJ3Jlc2V0JywgW10pLnRvU3RtdCgpO1xuICAgIG1ldGhvZC5hZGRTdG10KGluaXRWYWx1ZVVud3JhcHBlclN0bXQpO1xuICB9XG4gIG1ldGhvZC5hZGRTdG10KFxuICAgICAgY3VyclZhbEV4cHIuc2V0KGNoZWNrRXhwcmVzc2lvbi5leHByZXNzaW9uKS50b0RlY2xTdG10KG51bGwsIFtvLlN0bXRNb2RpZmllci5GaW5hbF0pKTtcblxuICB2YXIgY29uZGl0aW9uOiBvLkV4cHJlc3Npb24gPVxuICAgICAgby5pbXBvcnRFeHByKElkZW50aWZpZXJzLmNoZWNrQmluZGluZylcbiAgICAgICAgICAuY2FsbEZuKFtEZXRlY3RDaGFuZ2VzVmFycy50aHJvd09uQ2hhbmdlLCBmaWVsZEV4cHIsIGN1cnJWYWxFeHByXSk7XG4gIGlmIChjaGVja0V4cHJlc3Npb24ubmVlZHNWYWx1ZVVud3JhcHBlcikge1xuICAgIGNvbmRpdGlvbiA9IERldGVjdENoYW5nZXNWYXJzLnZhbFVud3JhcHBlci5wcm9wKCdoYXNXcmFwcGVkVmFsdWUnKS5vcihjb25kaXRpb24pO1xuICB9XG4gIG1ldGhvZC5hZGRTdG10KG5ldyBvLklmU3RtdChcbiAgICAgIGNvbmRpdGlvbixcbiAgICAgIGFjdGlvbnMuY29uY2F0KFs8by5TdGF0ZW1lbnQ+by5USElTX0VYUFIucHJvcChmaWVsZEV4cHIubmFtZSkuc2V0KGN1cnJWYWxFeHByKS50b1N0bXQoKV0pKSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBiaW5kUmVuZGVyVGV4dChib3VuZFRleHQ6IEJvdW5kVGV4dEFzdCwgY29tcGlsZU5vZGU6IENvbXBpbGVOb2RlLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZpZXc6IENvbXBpbGVWaWV3KSB7XG4gIHZhciBiaW5kaW5nSW5kZXggPSB2aWV3LmJpbmRpbmdzLmxlbmd0aDtcbiAgdmlldy5iaW5kaW5ncy5wdXNoKG5ldyBDb21waWxlQmluZGluZyhjb21waWxlTm9kZSwgYm91bmRUZXh0KSk7XG4gIHZhciBjdXJyVmFsRXhwciA9IGNyZWF0ZUN1cnJWYWx1ZUV4cHIoYmluZGluZ0luZGV4KTtcbiAgdmFyIHZhbHVlRmllbGQgPSBjcmVhdGVCaW5kRmllbGRFeHByKGJpbmRpbmdJbmRleCk7XG4gIHZpZXcuZGV0ZWN0Q2hhbmdlc1JlbmRlclByb3BlcnRpZXNNZXRob2QucmVzZXREZWJ1Z0luZm8oY29tcGlsZU5vZGUubm9kZUluZGV4LCBib3VuZFRleHQpO1xuXG4gIGJpbmQodmlldywgY3VyclZhbEV4cHIsIHZhbHVlRmllbGQsIGJvdW5kVGV4dC52YWx1ZSwgby5USElTX0VYUFIucHJvcCgnY29udGV4dCcpLFxuICAgICAgIFtcbiAgICAgICAgIG8uVEhJU19FWFBSLnByb3AoJ3JlbmRlcmVyJylcbiAgICAgICAgICAgICAuY2FsbE1ldGhvZCgnc2V0VGV4dCcsIFtjb21waWxlTm9kZS5yZW5kZXJOb2RlLCBjdXJyVmFsRXhwcl0pXG4gICAgICAgICAgICAgLnRvU3RtdCgpXG4gICAgICAgXSxcbiAgICAgICB2aWV3LmRldGVjdENoYW5nZXNSZW5kZXJQcm9wZXJ0aWVzTWV0aG9kKTtcbn1cblxuZnVuY3Rpb24gYmluZEFuZFdyaXRlVG9SZW5kZXJlcihib3VuZFByb3BzOiBCb3VuZEVsZW1lbnRQcm9wZXJ0eUFzdFtdLCBjb250ZXh0OiBvLkV4cHJlc3Npb24sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBpbGVFbGVtZW50OiBDb21waWxlRWxlbWVudCkge1xuICB2YXIgdmlldyA9IGNvbXBpbGVFbGVtZW50LnZpZXc7XG4gIHZhciByZW5kZXJOb2RlID0gY29tcGlsZUVsZW1lbnQucmVuZGVyTm9kZTtcbiAgYm91bmRQcm9wcy5mb3JFYWNoKChib3VuZFByb3ApID0+IHtcbiAgICB2YXIgYmluZGluZ0luZGV4ID0gdmlldy5iaW5kaW5ncy5sZW5ndGg7XG4gICAgdmlldy5iaW5kaW5ncy5wdXNoKG5ldyBDb21waWxlQmluZGluZyhjb21waWxlRWxlbWVudCwgYm91bmRQcm9wKSk7XG4gICAgdmlldy5kZXRlY3RDaGFuZ2VzUmVuZGVyUHJvcGVydGllc01ldGhvZC5yZXNldERlYnVnSW5mbyhjb21waWxlRWxlbWVudC5ub2RlSW5kZXgsIGJvdW5kUHJvcCk7XG4gICAgdmFyIGZpZWxkRXhwciA9IGNyZWF0ZUJpbmRGaWVsZEV4cHIoYmluZGluZ0luZGV4KTtcbiAgICB2YXIgY3VyclZhbEV4cHIgPSBjcmVhdGVDdXJyVmFsdWVFeHByKGJpbmRpbmdJbmRleCk7XG4gICAgdmFyIHJlbmRlck1ldGhvZDogc3RyaW5nO1xuICAgIHZhciByZW5kZXJWYWx1ZTogby5FeHByZXNzaW9uID0gY3VyclZhbEV4cHI7XG4gICAgdmFyIHVwZGF0ZVN0bXRzID0gW107XG4gICAgc3dpdGNoIChib3VuZFByb3AudHlwZSkge1xuICAgICAgY2FzZSBQcm9wZXJ0eUJpbmRpbmdUeXBlLlByb3BlcnR5OlxuICAgICAgICByZW5kZXJNZXRob2QgPSAnc2V0RWxlbWVudFByb3BlcnR5JztcbiAgICAgICAgaWYgKHZpZXcuZ2VuQ29uZmlnLmxvZ0JpbmRpbmdVcGRhdGUpIHtcbiAgICAgICAgICB1cGRhdGVTdG10cy5wdXNoKGxvZ0JpbmRpbmdVcGRhdGVTdG10KHJlbmRlck5vZGUsIGJvdW5kUHJvcC5uYW1lLCBjdXJyVmFsRXhwcikpO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBQcm9wZXJ0eUJpbmRpbmdUeXBlLkF0dHJpYnV0ZTpcbiAgICAgICAgcmVuZGVyTWV0aG9kID0gJ3NldEVsZW1lbnRBdHRyaWJ1dGUnO1xuICAgICAgICByZW5kZXJWYWx1ZSA9XG4gICAgICAgICAgICByZW5kZXJWYWx1ZS5pc0JsYW5rKCkuY29uZGl0aW9uYWwoby5OVUxMX0VYUFIsIHJlbmRlclZhbHVlLmNhbGxNZXRob2QoJ3RvU3RyaW5nJywgW10pKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIFByb3BlcnR5QmluZGluZ1R5cGUuQ2xhc3M6XG4gICAgICAgIHJlbmRlck1ldGhvZCA9ICdzZXRFbGVtZW50Q2xhc3MnO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgUHJvcGVydHlCaW5kaW5nVHlwZS5TdHlsZTpcbiAgICAgICAgcmVuZGVyTWV0aG9kID0gJ3NldEVsZW1lbnRTdHlsZSc7XG4gICAgICAgIHZhciBzdHJWYWx1ZTogby5FeHByZXNzaW9uID0gcmVuZGVyVmFsdWUuY2FsbE1ldGhvZCgndG9TdHJpbmcnLCBbXSk7XG4gICAgICAgIGlmIChpc1ByZXNlbnQoYm91bmRQcm9wLnVuaXQpKSB7XG4gICAgICAgICAgc3RyVmFsdWUgPSBzdHJWYWx1ZS5wbHVzKG8ubGl0ZXJhbChib3VuZFByb3AudW5pdCkpO1xuICAgICAgICB9XG4gICAgICAgIHJlbmRlclZhbHVlID0gcmVuZGVyVmFsdWUuaXNCbGFuaygpLmNvbmRpdGlvbmFsKG8uTlVMTF9FWFBSLCBzdHJWYWx1ZSk7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgICB1cGRhdGVTdG10cy5wdXNoKFxuICAgICAgICBvLlRISVNfRVhQUi5wcm9wKCdyZW5kZXJlcicpXG4gICAgICAgICAgICAuY2FsbE1ldGhvZChyZW5kZXJNZXRob2QsIFtyZW5kZXJOb2RlLCBvLmxpdGVyYWwoYm91bmRQcm9wLm5hbWUpLCByZW5kZXJWYWx1ZV0pXG4gICAgICAgICAgICAudG9TdG10KCkpO1xuXG4gICAgYmluZCh2aWV3LCBjdXJyVmFsRXhwciwgZmllbGRFeHByLCBib3VuZFByb3AudmFsdWUsIGNvbnRleHQsIHVwZGF0ZVN0bXRzLFxuICAgICAgICAgdmlldy5kZXRlY3RDaGFuZ2VzUmVuZGVyUHJvcGVydGllc01ldGhvZCk7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYmluZFJlbmRlcklucHV0cyhib3VuZFByb3BzOiBCb3VuZEVsZW1lbnRQcm9wZXJ0eUFzdFtdLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcGlsZUVsZW1lbnQ6IENvbXBpbGVFbGVtZW50KTogdm9pZCB7XG4gIGJpbmRBbmRXcml0ZVRvUmVuZGVyZXIoYm91bmRQcm9wcywgby5USElTX0VYUFIucHJvcCgnY29udGV4dCcpLCBjb21waWxlRWxlbWVudCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBiaW5kRGlyZWN0aXZlSG9zdFByb3BzKGRpcmVjdGl2ZUFzdDogRGlyZWN0aXZlQXN0LCBkaXJlY3RpdmVJbnN0YW5jZTogby5FeHByZXNzaW9uLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29tcGlsZUVsZW1lbnQ6IENvbXBpbGVFbGVtZW50KTogdm9pZCB7XG4gIGJpbmRBbmRXcml0ZVRvUmVuZGVyZXIoZGlyZWN0aXZlQXN0Lmhvc3RQcm9wZXJ0aWVzLCBkaXJlY3RpdmVJbnN0YW5jZSwgY29tcGlsZUVsZW1lbnQpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYmluZERpcmVjdGl2ZUlucHV0cyhkaXJlY3RpdmVBc3Q6IERpcmVjdGl2ZUFzdCwgZGlyZWN0aXZlSW5zdGFuY2U6IG8uRXhwcmVzc2lvbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbXBpbGVFbGVtZW50OiBDb21waWxlRWxlbWVudCkge1xuICBpZiAoZGlyZWN0aXZlQXN0LmlucHV0cy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdmFyIHZpZXcgPSBjb21waWxlRWxlbWVudC52aWV3O1xuICB2YXIgZGV0ZWN0Q2hhbmdlc0luSW5wdXRzTWV0aG9kID0gdmlldy5kZXRlY3RDaGFuZ2VzSW5JbnB1dHNNZXRob2Q7XG4gIGRldGVjdENoYW5nZXNJbklucHV0c01ldGhvZC5yZXNldERlYnVnSW5mbyhjb21waWxlRWxlbWVudC5ub2RlSW5kZXgsIGNvbXBpbGVFbGVtZW50LnNvdXJjZUFzdCk7XG5cbiAgdmFyIGxpZmVjeWNsZUhvb2tzID0gZGlyZWN0aXZlQXN0LmRpcmVjdGl2ZS5saWZlY3ljbGVIb29rcztcbiAgdmFyIGNhbGNDaGFuZ2VzTWFwID0gbGlmZWN5Y2xlSG9va3MuaW5kZXhPZihMaWZlY3ljbGVIb29rcy5PbkNoYW5nZXMpICE9PSAtMTtcbiAgdmFyIGlzT25QdXNoQ29tcCA9IGRpcmVjdGl2ZUFzdC5kaXJlY3RpdmUuaXNDb21wb25lbnQgJiZcbiAgICAgICAgICAgICAgICAgICAgICFpc0RlZmF1bHRDaGFuZ2VEZXRlY3Rpb25TdHJhdGVneShkaXJlY3RpdmVBc3QuZGlyZWN0aXZlLmNoYW5nZURldGVjdGlvbik7XG4gIGlmIChjYWxjQ2hhbmdlc01hcCkge1xuICAgIGRldGVjdENoYW5nZXNJbklucHV0c01ldGhvZC5hZGRTdG10KERldGVjdENoYW5nZXNWYXJzLmNoYW5nZXMuc2V0KG8uTlVMTF9FWFBSKS50b1N0bXQoKSk7XG4gIH1cbiAgaWYgKGlzT25QdXNoQ29tcCkge1xuICAgIGRldGVjdENoYW5nZXNJbklucHV0c01ldGhvZC5hZGRTdG10KERldGVjdENoYW5nZXNWYXJzLmNoYW5nZWQuc2V0KG8ubGl0ZXJhbChmYWxzZSkpLnRvU3RtdCgpKTtcbiAgfVxuICBkaXJlY3RpdmVBc3QuaW5wdXRzLmZvckVhY2goKGlucHV0KSA9PiB7XG4gICAgdmFyIGJpbmRpbmdJbmRleCA9IHZpZXcuYmluZGluZ3MubGVuZ3RoO1xuICAgIHZpZXcuYmluZGluZ3MucHVzaChuZXcgQ29tcGlsZUJpbmRpbmcoY29tcGlsZUVsZW1lbnQsIGlucHV0KSk7XG4gICAgZGV0ZWN0Q2hhbmdlc0luSW5wdXRzTWV0aG9kLnJlc2V0RGVidWdJbmZvKGNvbXBpbGVFbGVtZW50Lm5vZGVJbmRleCwgaW5wdXQpO1xuICAgIHZhciBmaWVsZEV4cHIgPSBjcmVhdGVCaW5kRmllbGRFeHByKGJpbmRpbmdJbmRleCk7XG4gICAgdmFyIGN1cnJWYWxFeHByID0gY3JlYXRlQ3VyclZhbHVlRXhwcihiaW5kaW5nSW5kZXgpO1xuICAgIHZhciBzdGF0ZW1lbnRzOiBvLlN0YXRlbWVudFtdID1cbiAgICAgICAgW2RpcmVjdGl2ZUluc3RhbmNlLnByb3AoaW5wdXQuZGlyZWN0aXZlTmFtZSkuc2V0KGN1cnJWYWxFeHByKS50b1N0bXQoKV07XG4gICAgaWYgKGNhbGNDaGFuZ2VzTWFwKSB7XG4gICAgICBzdGF0ZW1lbnRzLnB1c2gobmV3IG8uSWZTdG10KERldGVjdENoYW5nZXNWYXJzLmNoYW5nZXMuaWRlbnRpY2FsKG8uTlVMTF9FWFBSKSwgW1xuICAgICAgICBEZXRlY3RDaGFuZ2VzVmFycy5jaGFuZ2VzLnNldChvLmxpdGVyYWxNYXAoW10sIG5ldyBvLk1hcFR5cGUoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG8uaW1wb3J0VHlwZShJZGVudGlmaWVycy5TaW1wbGVDaGFuZ2UpKSkpXG4gICAgICAgICAgICAudG9TdG10KClcbiAgICAgIF0pKTtcbiAgICAgIHN0YXRlbWVudHMucHVzaChcbiAgICAgICAgICBEZXRlY3RDaGFuZ2VzVmFycy5jaGFuZ2VzLmtleShvLmxpdGVyYWwoaW5wdXQuZGlyZWN0aXZlTmFtZSkpXG4gICAgICAgICAgICAgIC5zZXQoby5pbXBvcnRFeHByKElkZW50aWZpZXJzLlNpbXBsZUNoYW5nZSkuaW5zdGFudGlhdGUoW2ZpZWxkRXhwciwgY3VyclZhbEV4cHJdKSlcbiAgICAgICAgICAgICAgLnRvU3RtdCgpKTtcbiAgICB9XG4gICAgaWYgKGlzT25QdXNoQ29tcCkge1xuICAgICAgc3RhdGVtZW50cy5wdXNoKERldGVjdENoYW5nZXNWYXJzLmNoYW5nZWQuc2V0KG8ubGl0ZXJhbCh0cnVlKSkudG9TdG10KCkpO1xuICAgIH1cbiAgICBpZiAodmlldy5nZW5Db25maWcubG9nQmluZGluZ1VwZGF0ZSkge1xuICAgICAgc3RhdGVtZW50cy5wdXNoKFxuICAgICAgICAgIGxvZ0JpbmRpbmdVcGRhdGVTdG10KGNvbXBpbGVFbGVtZW50LnJlbmRlck5vZGUsIGlucHV0LmRpcmVjdGl2ZU5hbWUsIGN1cnJWYWxFeHByKSk7XG4gICAgfVxuICAgIGJpbmQodmlldywgY3VyclZhbEV4cHIsIGZpZWxkRXhwciwgaW5wdXQudmFsdWUsIG8uVEhJU19FWFBSLnByb3AoJ2NvbnRleHQnKSwgc3RhdGVtZW50cyxcbiAgICAgICAgIGRldGVjdENoYW5nZXNJbklucHV0c01ldGhvZCk7XG4gIH0pO1xuICBpZiAoaXNPblB1c2hDb21wKSB7XG4gICAgZGV0ZWN0Q2hhbmdlc0luSW5wdXRzTWV0aG9kLmFkZFN0bXQobmV3IG8uSWZTdG10KERldGVjdENoYW5nZXNWYXJzLmNoYW5nZWQsIFtcbiAgICAgIGNvbXBpbGVFbGVtZW50LmFwcEVsZW1lbnQucHJvcCgnY29tcG9uZW50VmlldycpXG4gICAgICAgICAgLmNhbGxNZXRob2QoJ21hcmtBc0NoZWNrT25jZScsIFtdKVxuICAgICAgICAgIC50b1N0bXQoKVxuICAgIF0pKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBsb2dCaW5kaW5nVXBkYXRlU3RtdChyZW5kZXJOb2RlOiBvLkV4cHJlc3Npb24sIHByb3BOYW1lOiBzdHJpbmcsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZTogby5FeHByZXNzaW9uKTogby5TdGF0ZW1lbnQge1xuICByZXR1cm4gby5USElTX0VYUFIucHJvcCgncmVuZGVyZXInKVxuICAgICAgLmNhbGxNZXRob2QoJ3NldEJpbmRpbmdEZWJ1Z0luZm8nLFxuICAgICAgICAgICAgICAgICAgW1xuICAgICAgICAgICAgICAgICAgICByZW5kZXJOb2RlLFxuICAgICAgICAgICAgICAgICAgICBvLmxpdGVyYWwoYG5nLXJlZmxlY3QtJHtjYW1lbENhc2VUb0Rhc2hDYXNlKHByb3BOYW1lKX1gKSxcbiAgICAgICAgICAgICAgICAgICAgdmFsdWUuaXNCbGFuaygpLmNvbmRpdGlvbmFsKG8uTlVMTF9FWFBSLCB2YWx1ZS5jYWxsTWV0aG9kKCd0b1N0cmluZycsIFtdKSlcbiAgICAgICAgICAgICAgICAgIF0pXG4gICAgICAudG9TdG10KCk7XG59XG4iXX0=