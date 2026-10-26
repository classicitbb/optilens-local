"use strict";
// One family per material/manufacturer/design/colour and optical family.
// Diameter stays a separate matrix so unlike blanks never merge in one cell.
(function(root, factory) {
  const api=factory();
  if(typeof module==="object"&&module.exports) module.exports=api;
  else root.ClearanceGrids=api;
})(typeof globalThis!=="undefined"?globalThis:this, function() {
  function gridsFor(items) {
    const families=new Map();
    for(const item of items) {
      if(!(item.quantity>0&&item.priceBbd>0)||!["pairs","each"].includes(item.unit)) continue;
      const key=JSON.stringify([item.material,item.manufacturer,item.design,item.option,item.family]);
      if(!families.has(key)) families.set(key,{key,material:item.material,manufacturer:item.manufacturer,design:item.design,option:item.option,family:item.family,unit:item.unit,quantity:0,items:[],diameters:new Map()});
      const family=families.get(key);
      family.quantity+=item.quantity;family.items.push(item);
      const d=item.diameter;
      if(!family.diameters.has(d))family.diameters.set(d,{diameter:d,verticalAxis:item.verticalAxis,horizontalAxis:item.horizontalAxis,unit:item.unit,rows:new Set(),columns:new Set(),cells:new Map()});
      const grid=family.diameters.get(d);
      const row=Math.round(item.base*100),column=Math.round(item.addPower*100);
      grid.rows.add(row);grid.columns.add(column);
      const cellKey=row+":"+column;
      if(!grid.cells.has(cellKey))grid.cells.set(cellKey,[]);
      grid.cells.get(cellKey).push(item);
    }
    return [...families.values()].map(family=>({...family,grids:[...family.diameters.values()].sort((a,b)=>a.diameter-b.diameter).map(grid=>({...grid,rows:[...grid.rows].sort((a,b)=>b-a),columns:[...grid.columns].sort((a,b)=>grid.horizontalAxis==="Cylinder"?b-a:a-b)}))}));
  }
  function power(value) {const n=value/100;return (n>0?"+":"")+n.toFixed(2);}
  return {gridsFor,power};
});
