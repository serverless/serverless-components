import { filter, forEach, get, isFunction, isObject, map, or, resolve } from '@serverless/utils'
import appendKey from './appendKey'
import getKey from './getKey'
import hydrateComponent from './hydrateComponent'
import isComponent from './isComponent'
import setKey from './setKey'

/**
 *
 */
const defineComponent = async (component, state, context) => {
  // TODO BRN: If we ever need to retrigger define (redefine) hydrating state here may be an issue
  if (!isComponent(component)) {
    throw new TypeError(
      `defineComponent expected component parameter to be a component. Instead received ${component}`
    )
  }
  component = hydrateComponent(component, state, context)
  if (isFunction(component.define)) {
    let children = await or(component.define(context), {})
    children = filter(isComponent, map(resolve, children))

    if (isObject(children)) {
      forEach((child, kdx) => {
        // TODO BRN: Look for children that already have parents. If this is the case then someone has returned a child from define that was defined by another component (possibly passed along as a variable)
        child.parent = component
        child = setKey(appendKey(getKey(component), kdx), child)
      }, children)
    } else {
      throw new Error(
        `define() method must return either an object or an array. Instead received ${children} from ${component}.`
      )
    }
    component.children = await map(
      async (child, key) => defineComponent(child, get(['children', key], state), context),
      children
    )
  }
  return component
}

export default defineComponent