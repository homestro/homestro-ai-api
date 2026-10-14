import test from 'node:test';
import assert from 'node:assert/strict';
import {storyAss,wrapStoryText} from '../modules/video-story.js';
test('story captions use explicit portrait resolution and do not admit subtitle commands',()=>{
 const ass=storyAss({hook:'Mehr Ordnung',title:'Produkt',benefits:[{text:'Ein belegter Vorteil'}]},'Das ist ein sinnvoller Text mit einem echten Vorteil.',15);
 assert.match(ass,/PlayResX: 720/);assert.match(ass,/PlayResY: 1280/);
 assert.match(ass,/Jetzt bei Homestro/);assert.match(ass,/entdecken/);assert.match(ass,/homestro.de/);
 assert.ok(!wrapStoryText('{\\pos(1,1)} fremder Text').includes('{'));
 assert.equal(wrapStoryText('eins zwei drei vier fünf sechs sieben acht neun',12,2).split('\\N').length,2);
});
