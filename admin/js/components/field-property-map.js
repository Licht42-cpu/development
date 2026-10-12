import { el } from '../../../shared/dom.js';
import { isNative } from '../lib/native.js';

const NS='http://www.w3.org/2000/svg';
function svgNode(name, attrs) {
  const node=document.createElementNS(NS,name);
  for(const [key,value] of Object.entries(attrs))node.setAttribute(key,value);
  return node;
}
export function knownCoordinates(point) {
  return point?.state === 'known' && typeof point.lat === 'number' && typeof point.lng === 'number' &&
    Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat)<=90 && Math.abs(point.lng)<=180;
}
export function navigationUrl(value) {
  return knownCoordinates(value.coordinates)
    ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${value.coordinates.lat},${value.coordinates.lng}`)}` : null;
}
function drawing(points, project, pin, label) {
  const svg=svgNode('svg',{viewBox:'0 0 320 220',role:'img','aria-label':label});
  if(points.length)svg.append(svgNode('polygon',{points:points.map(project).map(p=>p.join(',')).join(' '),fill:'#e2eff8',stroke:'#21577a','stroke-width':'2'}));
  if(pin) {const [cx,cy]=project(pin);svg.append(svgNode('circle',{cx,cy,r:'6',fill:'#a43324'}));}
  return svg;
}
export function propertyMap(value, {offline=false}={}) {
  const root=el('section',{class:'field-property-map'},[
    el('h3',{text:'Property pin and work zones'}),
    el('p',{class:'hint',text:'Owner drawings, not surveyed boundaries. No basemap, imagery, geofence or route is saved.'})
  ]);
  const coords=value.coordinates;
  if(knownCoordinates(coords)) {
    root.append(el('p',{text:`Property pin: ${coords.lat}, ${coords.lng}. This is not a verified entrance.`}));
    const url=navigationUrl(value);
    root.append(el('a',{class:'btn',href:url,...(isNative()?{}:{target:'_blank',rel:'noopener noreferrer'}),text:'Open device navigation'}),
      el('p',{class:'hint',text:offline ? 'Cached destination only. An external navigation app may need a connection; its offline maps were not checked.'
        : 'Opens an external navigation link. Routing and navigation-app availability are not verified here.'}));
  } else root.append(el('p',{text:'Property coordinates missing or invalid. No destination or arrival was guessed.'}));
  const geo=value.zones.filter(zone=>zone.space==='geographic');
  if(knownCoordinates(coords) || geo.length) {
    const points=[...(knownCoordinates(coords)?[coords]:[]),...geo.flatMap(zone=>zone.points||[])]
      .filter(p=>knownCoordinates({...p,state:'known'}));
    if(points.length) {
      const lats=points.map(p=>p.lat),lngs=points.map(p=>p.lng);
      const minLat=Math.min(...lats),maxLat=Math.max(...lats),minLng=Math.min(...lngs),maxLng=Math.max(...lngs);
      const project=p=>[30+260*(p.lng-minLng)/(maxLng-minLng||0.001),190-160*(p.lat-minLat)/(maxLat-minLat||0.001)];
      const map=drawing([],project,knownCoordinates(coords)?coords:null,'Geographic overview of the property pin and owner-drawn zones');
      for(const zone of geo)if(zone.points?.length>=3 && zone.points.every(p=>knownCoordinates({...p,state:'known'})))
        map.append(svgNode('polygon',{points:zone.points.map(project).map(p=>p.join(',')).join(' '),fill:'none',stroke:'#21577a','stroke-width':'2'}));
      root.append(map,el('p',{class:'hint',text:'Geographic overview — independently fitted axes; not to scale. North is up.'}));
    }
  }
  if(!value.zones.length)root.append(el('p',{text:'No work zones recorded.'}));
  for(const zone of value.zones) {
    const details=el('details',{},[el('summary',{text:`${zone.label} — ${zone.kind.replaceAll('_',' ')} (${zone.space})`}),
      el('p',{text:zone.note||'No zone instruction recorded.'})]);
    if(zone.space==='image') {
      details.append(el('p',{text:`Image reference: ${zone.image_source || 'missing'}. Reference image is not available in this offline drawing.`}));
      if(zone.points?.length>=3 && zone.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1))
        details.append(drawing(zone.points,p=>[20+280*p.x,20+180*p.y],null,`${zone.label}: normalized image zone, no geographic coordinates`));
    }
    details.append(el('ol',{},(zone.points||[]).map(p=>el('li',{text:zone.space==='geographic' ? `Latitude ${p.lat}; longitude ${p.lng}` : `Image x ${p.x}; y ${p.y}`}))));
    root.append(details);
  }
  return root;
}
